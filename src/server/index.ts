// Studio server: streams the artist's work to viewers over WebSocket.
// It starts idle. A viewer clicking "Begin" starts a run of WORKS_PER_RUN works (resting
// REST_SECONDS between them), after which it returns to idle and the button offers to continue.
// The run stops early if the browser tab that started it is closed.
//   npm run dev                 → server + Vite dev client (http://localhost:5173)
//   npm run build && npm start  → production: this server also serves the built client
//   flags: --prod  --once (one work per run)  --list-models

import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';
import { Archive, DATA_DIR } from './archive.ts';
import { runSession, sleep, type AgentConfig } from './agent.ts';
import { encode, loadFonts, nodePlatform } from './platform.ts';
import { authRequired, checkPassword, isAuthed, loginCookie, readBody } from './auth.ts';
import { StudioDocument } from '../engine/document.ts';
import type { ClientMessage, ServerMessage, StudioEvent, StudioState } from '../shared/events.ts';

const args = new Set(process.argv.slice(2));
const PROD = args.has('--prod');
const PORT = Number(process.env.PORT ?? 8787);
const REST_SECONDS = Number(process.env.REST_SECONDS ?? 20);
const WORKS_PER_RUN = args.has('--once') ? 1 : Math.max(1, Math.round(Number(process.env.WORKS_PER_RUN ?? 10)));
const OWNER_GRACE_MS = 10_000; // a reload reconnects well within this; a closed tab doesn't
const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;

if (!apiKey) console.warn('[studio] GEMINI_API_KEY is not set — the site will run, but the studio cannot start. Add it to .env, or to the hosting environment variables.');
const ai = new GoogleGenAI({ apiKey: apiKey ?? 'none' });

if (args.has('--list-models')) {
  const pager = await ai.models.list();
  for await (const m of pager) {
    if (m.supportedActions?.includes('generateContent') && /gemini/i.test(m.name ?? '')) console.log(m.name?.replace('models/', ''), '—', m.displayName);
  }
  process.exit(0);
}

loadFonts();
const archive = new Archive();
await recoverInterrupted();

/** Sessions cut off mid-work (server restarted or crashed) are rebuilt from their replay log
 *  and marked unfinished, so they appear in the gallery instead of staying "working" forever. */
async function recoverInterrupted() {
  for (const m of archive.list().filter((s) => s.status === 'working')) {
    try {
      const events = archive.events(m.id);
      const doc = new StudioDocument(nodePlatform);
      let ops = 0;
      for (const e of events) if (e.type === 'op') { try { doc.apply(e.op); ops++; } catch { /* skip bad op */ } }
      const w = archive.create(m);
      w.meta.status = 'ended';
      w.meta.endReason = 'interrupted — the server stopped mid-work';
      w.meta.endedAt = new Date(Date.parse(m.startedAt) + (events.at(-1)?.t ?? 0)).toISOString();
      w.meta.actions = ops;
      w.meta.width = doc.width; w.meta.height = doc.height;
      w.saveFile('final.png', await encode(doc.flatten('#ffffff'), 'png'));
      w.saveFile('thumb.jpg', await encode(doc.flatten('#ffffff', 640), 'jpeg', 85));
      w.saveMeta();
      console.log(`[studio] recovered interrupted session ${m.id} (${ops} actions)`);
    } catch (e) {
      console.warn(`[studio] could not recover ${m.id}:`, (e as Error).message);
    }
  }
}
const cfg: AgentConfig = {
  ai,
  model: process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview',
  thinkingLevel: (process.env.THINKING_LEVEL || 'HIGH').toUpperCase(),
  temperature: Number(process.env.TEMPERATURE ?? 1),
  maxTurns: Number(process.env.MAX_TURNS ?? 150),
  minTurns: Math.min(Number(process.env.MAX_TURNS ?? 150), Math.max(1, Number(process.env.MIN_TURNS ?? 15))),
  maxToolCalls: Number(process.env.MAX_TOOL_CALLS ?? 1500),
  viewSize: 1024,
  rememberPastWorks: /^(1|true|yes)$/i.test(process.env.REMEMBER_PAST_WORKS ?? ''),
};

// ------------------------------------------------------------------ live state & broadcast

let state: StudioState = { phase: 'idle', worksPerRun: WORKS_PER_RUN, completedRun: false };
let current: StudioEvent[] = [];
const clients = new Map<WebSocket, { tab: string | null }>();

/** The running studio and the browser tab that started it. */
let run: {
  owner: string;
  abort: AbortController;
  graceTimer: NodeJS.Timeout | null;
  /** ends the current work (or rest) so the run moves on to the next work */
  next: (() => void) | null;
} | null = null;

const isOwner = (ws: WebSocket) => !!run && clients.get(ws)?.tab === run.owner;

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) if (ws.readyState === ws.OPEN) ws.send(data);
}
function setState(s: StudioState) {
  state = s;
  for (const ws of clients.keys()) send(ws, { type: 'state', state, owner: isOwner(ws), serverTime: Date.now() });
}

function startStudio(owner: string) {
  if (run) return;
  if (!apiKey) { console.warn('[studio] cannot start: GEMINI_API_KEY is not set'); return; }
  run = { owner, abort: new AbortController(), graceTimer: null, next: null };
  console.log(`[studio] run started by a viewer — up to ${WORKS_PER_RUN} works, or until their tab is closed`);
  let completed = false;
  studioLoop(run.abort.signal)
    .then((done) => { completed = done; })
    .catch((e) => console.error('[studio] loop crashed', e))
    .finally(() => {
      if (run?.graceTimer) clearTimeout(run.graceTimer);
      run = null;
      setState({ phase: 'idle', worksPerRun: WORKS_PER_RUN, completedRun: completed });
      console.log(completed ? `[studio] run complete (${WORKS_PER_RUN} works) — idle until someone presses Continue` : '[studio] idle — waiting for someone to press Begin');
    });
}

/** Abort the whole run (the current work is archived as unfinished). */
function stopStudio(reason: string) {
  if (!run || run.abort.signal.aborted) return;
  console.log(`[studio] stopping: ${reason}`);
  setState({ phase: 'stopping' });
  run.abort.abort(`stopped — ${reason}`);
}

/** Called whenever a connection closes or identifies: stop if the owner's tab is gone for good. */
function checkOwnerPresence() {
  if (!run) return;
  const present = [...clients.values()].some((c) => c.tab === run!.owner);
  if (present) {
    if (run.graceTimer) { clearTimeout(run.graceTimer); run.graceTimer = null; }
  } else if (!run.graceTimer) {
    run.graceTimer = setTimeout(() => stopStudio('the viewer who started it closed their window'), OWNER_GRACE_MS);
  }
}

/** Makes up to WORKS_PER_RUN works. Resolves true if all were made, false if stopped early. */
async function studioLoop(signal: AbortSignal): Promise<boolean> {
  for (let work = 1; work <= WORKS_PER_RUN; work++) {
    if (signal.aborted) return false;
    current = [];
    setState({ phase: 'working', sessionId: '', work, of: WORKS_PER_RUN });
    // each work can be ended on its own ("New work") without stopping the run
    const thisWork = new AbortController();
    if (run) run.next = () => thisWork.abort('stopped — a new work was started');
    const meta = await runSession(cfg, archive, {
      onEvent(e) {
        if (e.type === 'session') setState({ phase: 'working', sessionId: e.id, work, of: WORKS_PER_RUN });
        current.push(e);
        broadcast({ type: 'event', event: e });
      },
      signal: AbortSignal.any([signal, thisWork.signal]),
    });
    console.log(`[studio] work ${work}/${WORKS_PER_RUN} done — tokens: in ${meta.tokens.input}, out ${meta.tokens.output}, thinking ${meta.tokens.thoughts}`);
    if (signal.aborted) return false;
    if (work === WORKS_PER_RUN) return true;
    // "New work" during a work means "start the next one now": no rest in between
    const skippedByOwner = thisWork.signal.aborted;
    if (REST_SECONDS > 0 && !skippedByOwner) {
      const rest = new AbortController();
      if (run) run.next = () => rest.abort(); // "New work" during the rest starts it right away
      setState({ phase: 'resting', nextAt: Date.now() + REST_SECONDS * 1000, lastId: meta.id, work: work + 1, of: WORKS_PER_RUN });
      await sleep(REST_SECONDS * 1000, AbortSignal.any([signal, rest.signal]));
    }
  }
  return true;
}

// ------------------------------------------------------------------ http

const clientDir = fileURLToPath(new URL('../../dist/client/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;

  // open endpoints: health check (for the host) and the login flow
  if (p === '/api/health') return json(res, { ok: true });
  if (p === '/api/auth') return json(res, { required: authRequired(), ok: isAuthed(req) });
  if (p === '/api/login' && req.method === 'POST') {
    let attempt: unknown;
    try { attempt = JSON.parse(await readBody(req)).password; } catch { return json(res, { ok: false }, 400); }
    if (!checkPassword(attempt)) {
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return json(res, { ok: false }, 401);
    }
    res.setHeader('set-cookie', loginCookie(req));
    return json(res, { ok: true });
  }
  // everything else under /api needs the password (the page shell itself is public but shows nothing)
  if (p.startsWith('/api/') && !isAuthed(req)) return json(res, { error: 'password required' }, 401);

  if (p === '/api/state') return json(res, { state, model: cfg.model });
  if (p === '/api/sessions') return json(res, archive.list());
  const m = p.match(/^\/api\/sessions\/([\w-]+)\/(events|final\.png|thumb\.jpg|meta)$/);
  if (m) {
    try {
      if (m[2] === 'events') return json(res, archive.events(m[1]));
      if (m[2] === 'meta') return json(res, archive.list().find((s) => s.id === m[1]) ?? null);
      const file = archive.file(m[1], m[2]);
      if (!file) return json(res, { error: 'not found' }, 404);
      res.writeHead(200, { 'content-type': MIME[extname(m[2])], 'cache-control': 'public, max-age=300' });
      return res.end(file);
    } catch { return json(res, { error: 'bad request' }, 400); }
  }

  if (PROD) {
    const rel = normalize(decodeURIComponent(p)).replace(/^([/\\])+/, '');
    let file = join(clientDir, rel);
    if (!file.startsWith(clientDir) || !existsSync(file) || rel === '') file = join(clientDir, 'index.html');
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      return res.end(body);
    } catch { /* fallthrough */ }
  }
  json(res, { error: 'not found' }, 404);
}

const server = createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); json(res, { error: 'server error' }, 500); }); });
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }: { req: IncomingMessage }) => isAuthed(req) });

// ping every viewer regularly so proxies (e.g. Render's) don't drop quiet connections
const alive = new WeakSet<WebSocket>();
setInterval(() => {
  for (const ws of clients.keys()) {
    if (!alive.has(ws)) { ws.terminate(); continue; }
    alive.delete(ws);
    ws.ping();
  }
}, 25_000);
wss.on('connection', (ws) => {
  clients.set(ws, { tab: null });
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));
  send(ws, { type: 'hello', state, owner: false, events: current, serverTime: Date.now() });
  ws.on('message', (data) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (typeof msg?.tab !== 'string' || !/^[\w-]{8,64}$/.test(msg.tab)) return;
    clients.set(ws, { tab: msg.tab });
    if (msg.type === 'start' && state.phase === 'idle') startStudio(msg.tab);
    if (msg.type === 'next' && run?.owner === msg.tab && run.next) {
      console.log('[studio] the owner asked for a new work');
      run.next();
      run.next = null;
    }
    checkOwnerPresence();
    send(ws, { type: 'state', state, owner: isOwner(ws), serverTime: Date.now() });
  });
  ws.on('close', () => { clients.delete(ws); checkOwnerPresence(); });
});

server.listen(PORT, () => {
  console.log(`[studio] listening on http://localhost:${PORT}${PROD ? '' : '  (viewer: http://localhost:5173)'}`);
  console.log(`[studio] model ${cfg.model}, thinking ${cfg.thinkingLevel}, turns ${cfg.minTurns}–${cfg.maxTurns} per work, ${WORKS_PER_RUN} works per run`);
  console.log(`[studio] archive: ${DATA_DIR} · site password ${authRequired() ? 'ON' : 'off (set SITE_PASSWORD to require one)'}`);
  console.log('[studio] idle — open the site and press Begin to start the artist');
});

const shutdown = () => { console.log('\n[studio] shutting down'); run?.abort.abort(); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
