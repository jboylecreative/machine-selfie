import { FONTS, fontFile } from '../engine/fonts.ts';
import type { ClientMessage, ServerMessage, SessionMeta, Spend, StudioEvent, StudioState } from '../shared/events.ts';
import { Player } from './player.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const art = $<HTMLCanvasElement>('art');
const overlay = $<HTMLCanvasElement>('overlay');
const stream = $('stream');
const frame = $('frame');
const stage = $('stage');

// ------------------------------------------------------------------ fonts (must match the server renderer)

async function loadFonts() {
  const faces: Promise<unknown>[] = [];
  for (const f of FONTS) for (const w of f.weights) for (const s of f.italic ? ['normal', 'italic'] : ['normal']) {
    const face = new FontFace(f.family, `url(/fonts/${fontFile(f.id, w, s)})`, { weight: String(w), style: s });
    document.fonts.add(face);
    faces.push(face.load().catch(() => console.warn('font failed', f.family, w, s)));
  }
  await Promise.all(faces);
}

// ------------------------------------------------------------------ the mind stream

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const md = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

let lastBlock: { el: HTMLElement; kind: string; raw: string; count?: number; key?: string } | null = null;

function nearBottom() { return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120; }

function addBlock(kind: string, html: string, raw = '', key?: string): HTMLElement {
  const stick = nearBottom();
  const el = document.createElement('div');
  el.className = kind;
  el.innerHTML = html;
  stream.appendChild(el);
  while (stream.childElementCount > 500) stream.firstElementChild!.remove();
  lastBlock = { el, kind, raw, key, count: 1 };
  if (stick) stream.scrollTop = stream.scrollHeight;
  return el;
}

function appendText(kind: 'thought' | 'speech', text: string) {
  if (lastBlock?.kind === kind) {
    const stick = nearBottom();
    lastBlock.raw += text;
    lastBlock.el.innerHTML = md(lastBlock.raw.trim());
    if (stick) stream.scrollTop = stream.scrollHeight;
  } else addBlock(kind, md(text.trim()), text);
}

function describeOp(e: Extract<StudioEvent, { type: 'op' }>): { key: string; text: string } {
  const op = e.op;
  const layerName = (id: string) => player.doc.layers.find((l) => l.id === id)?.name ?? id;
  switch (op.t) {
    case 'stroke': return { key: `stroke:${op.brush.preset}:${op.layer}:${op.erase}`, text: `${op.erase ? 'erases with' : 'paints with'} <span class="k">${op.brush.preset}</span> · ${esc(layerName(op.layer))}` };
    case 'smudge': return { key: `smudge:${op.layer}`, text: `smudges · ${esc(layerName(op.layer))}` };
    case 'path': return { key: `path:${op.layer}`, text: `draws a <span class="k">shape</span> · ${esc(layerName(op.layer))}` };
    case 'fill': return { key: `fill:${op.layer}`, text: `<span class="k">${'gradient' in op.paint ? 'gradient' : 'fill'}</span> · ${esc(layerName(op.layer))}` };
    case 'flood': return { key: `flood:${op.layer}`, text: `<span class="k">bucket fill</span> · ${esc(layerName(op.layer))}` };
    case 'text': return { key: `text:${op.layer}:${Math.random()}`, text: `sets type in <span class="k">${esc(op.family)}</span>: “${esc(op.text.slice(0, 60))}${op.text.length > 60 ? '…' : ''}”` };
    case 'filter': return { key: `filter:${op.filter.kind}:${op.layer}`, text: `<span class="k">${op.filter.kind.replace(/_/g, ' ')}</span> · ${esc(layerName(op.layer))}` };
    case 'transform': return { key: `tf:${op.layer}`, text: `<span class="k">transforms</span> ${esc(layerName(op.layer))}` };
    case 'canvas': return { key: 'canvas', text: `prepares a <span class="k">${op.width}×${op.height}</span> canvas` };
    case 'layer.new': return { key: `ln:${op.id}`, text: `new ${op.adjustment ? `<span class="k">${op.adjustment.kind.replace(/_/g, ' ')}</span> adjustment` : 'layer'} “${esc(op.name)}”${op.blend !== 'normal' ? ` · ${op.blend}` : ''}` };
    case 'layer.set': return { key: `ls:${op.id}:${Math.random()}`, text: `adjusts layer ${esc(layerName(op.id))}: ${esc(Object.entries(op.props).map(([k, v]) => `${k} ${typeof v === 'object' ? (v as { kind: string }).kind : typeof v === 'number' ? Math.round(v * 100) / 100 : v}`).join(', '))}` };
    case 'layer.move': return { key: `lm:${op.id}`, text: `reorders ${esc(layerName(op.id))}` };
    case 'layer.delete': return { key: `ld:${op.id}`, text: `deletes ${esc(layerName(op.id))}` };
    case 'layer.duplicate': return { key: `ldup:${op.id}`, text: `duplicates ${esc(layerName(op.id))}` };
    case 'layer.merge': return { key: `lmg:${op.id}`, text: `merges ${esc(layerName(op.id))} down` };
    case 'layer.clear': return { key: `lc:${op.id}`, text: `clears ${esc(layerName(op.id))}` };
  }
}

function logOp(e: Extract<StudioEvent, { type: 'op' }>) {
  const { key, text } = describeOp(e);
  if (lastBlock?.kind === 'action' && lastBlock.key === key) {
    lastBlock.count = (lastBlock.count ?? 1) + 1;
    lastBlock.el.innerHTML = `<span>▸</span><span>${text} <span class="b">×${lastBlock.count}</span></span>`;
    return;
  }
  addBlock('action', `<span>▸</span><span>${text}</span>`, '', key);
}

let workNumber = 0;
function showEvent(e: StudioEvent) {
  switch (e.type) {
    case 'session':
      stream.innerHTML = '';
      lastBlock = null;
      workNumber = e.number;
      $('work-meta').textContent = `No. ${e.number}`;
      hideCaption();
      break;
    case 'turn': addBlock('turn-sep', `turn ${e.n}`); break;
    case 'thought': appendText('thought', e.text); break;
    case 'speech': appendText('speech', e.text); break;
    case 'note': addBlock('note', esc(e.text)); break;
    case 'look': addBlock('action', `<span>◉</span><span>looks ${e.region ? `closely at ${Math.round(e.region.x)},${Math.round(e.region.y)} (${Math.round(e.region.width)}×${Math.round(e.region.height)})` : 'at the whole canvas'}${e.grid ? ' with a grid' : ''}</span>`); break;
    case 'chance': addBlock('action', `<span>⚄</span><span>rolls chance → ${e.values.slice(0, 8).join(', ')}${e.values.length > 8 ? '…' : ''}</span>`); break;
    case 'tool_error': addBlock('action error', `<span>!</span><span>${esc(e.tool)}: ${esc(e.error)}</span>`); break;
    case 'finished':
      addBlock('finished-card', `<div class="lbl">finished</div><h3>${esc(e.title)}</h3><p>${esc(e.statement)}</p>`);
      showCaption(workNumber, e.title, e.statement);
      break;
    case 'ended': addBlock('action error', `<span>■</span><span>session ended — ${esc(e.reason)}</span>`); break;
  }
}

function showCaption(n: number, title: string, statement: string) {
  $('caption-no').textContent = `No. ${n}`;
  $('caption-title').textContent = title;
  $('caption-statement').textContent = statement;
  $('caption').hidden = false;
  layout();
}
function hideCaption() { $('caption').hidden = true; layout(); }

// ------------------------------------------------------------------ layers panel

function renderLayers() {
  const ol = $('layers');
  const active = player.activeLayer;
  ol.innerHTML = [...player.doc.layers].reverse().map((l) => {
    const cls = [l.id === active ? 'active' : '', l.visible ? '' : 'hidden'].join(' ');
    const badge = [l.kind === 'adjustment' ? l.adjustment?.kind.replace(/_/g, ' ') : '', l.blend !== 'normal' ? l.blend : '', l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : '', l.clip ? '↳clip' : '', l.alphaLock ? 'α' : ''].filter(Boolean).join(' · ');
    return `<li class="${cls}"><span>${esc(l.name)}</span><span class="b">${esc(badge)}</span></li>`;
  }).join('');
}

// ------------------------------------------------------------------ layout: fit the artwork to the stage

function layout() {
  const W = player.doc.width, H = player.doc.height;
  const extra = ($('caption').hidden ? 0 : $('caption').offsetHeight + 22) + ($('transport').hidden ? 0 : 52) + ($('next-btn').hidden ? 0 : 48);
  const pad = window.innerWidth < 900 ? 32 : 56;
  const maxW = stage.clientWidth - pad;
  const maxH = (window.innerWidth < 900 ? window.innerHeight * 0.62 : stage.clientHeight - pad) - extra;
  const s = Math.min(maxW / W, maxH / H);
  frame.style.width = `${Math.max(50, Math.floor(W * s))}px`;
  frame.style.height = `${Math.max(50, Math.floor(H * s))}px`;
}
new ResizeObserver(layout).observe(stage);

// ------------------------------------------------------------------ player

let layersDirty = false;
const player = new Player(art, overlay, {
  onEvent: (e) => showEvent(e),
  onOpStart: (e) => { logOp(e); layersDirty = true; },
  onResize: () => requestAnimationFrame(layout),
  onLayersChanged: () => { layersDirty = true; },
});
let lastActive: string | null = null;
setInterval(() => {
  if (layersDirty || player.activeLayer !== lastActive) { renderLayers(); layersDirty = false; lastActive = player.activeLayer; }
  updateStatus();
  updateTransport();
  updateBegin();
}, 250);

// ------------------------------------------------------------------ live connection

let liveEvents: StudioEvent[] = [];
let studioState: StudioState = { phase: 'idle', worksPerRun: 10, completedRun: false, blocked: null };
let connected = false;
let isOwner = false;
/** server clock minus this browser's clock: countdowns use server time, so a wrong local clock can't break them */
let clockOffset = 0;
let mode: 'live' | 'replay' = 'live';
let socket: WebSocket | null = null;

// One id per browser tab: sessionStorage survives a reload but not closing the tab, so the
// server can tell "this viewer refreshed" from "this viewer left".
const TAB = (() => {
  const key = 'artmaker-tab';
  let id: string | null = null;
  try { id = sessionStorage.getItem(key); } catch { /* storage blocked */ }
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    try { sessionStorage.setItem(key, id); } catch { /* storage blocked */ }
  }
  return id;
})();

function sendMsg(msg: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

// "New work" (owner only): ends the current work, or skips the rest, and moves on to the next work.
// Stays disabled until the studio moves on, so repeated clicks don't skip several works.
let nextRequestedAt: string | null = null;
const studioPosition = () =>
  studioState.phase === 'working' ? `w${studioState.work}:${studioState.sessionId}` : studioState.phase === 'resting' ? `r${studioState.work}` : studioState.phase;
$('next-btn').addEventListener('click', () => {
  ($('next-btn') as HTMLButtonElement).disabled = true;
  nextRequestedAt = studioPosition();
  sendMsg({ type: 'next', tab: TAB });
});

$('begin-btn').addEventListener('click', () => {
  ($('begin-btn') as HTMLButtonElement).disabled = true;
  sendMsg({ type: 'start', tab: TAB });
});

function updateBegin() {
  const idle = studioState.phase === 'idle' ? studioState : null;
  const show = mode === 'live' && connected && !!idle;
  $('begin').hidden = !show;
  if (!show) ($('begin-btn') as HTMLButtonElement).disabled = false;
  if (idle) {
    const n = idle.worksPerRun;
    const works = n === 1 ? 'one work' : `${n} works`;
    $('begin-btn').textContent = idle.completedRun ? 'Continue' : 'Begin';
    document.querySelector('.begin-lead')!.textContent = idle.completedRun ? `The artist has made ${works}.` : 'The studio is empty.';
    $('begin-note').textContent = `The artist will make ${idle.completedRun ? 'another ' : ''}${works}, resting between each. Keep this window open — closing it stops the studio.`;
    if (idle.blocked) {
      ($('begin-btn') as HTMLButtonElement).disabled = true;
      const [lead, note] = idle.blocked === 'total'
        ? ['We’ve exceeded our token limit.', '']
        : ['The studio can’t open yet.', 'Its storage isn’t set up, so the spending limit couldn’t be enforced. (Attach a volume to the service.)'];
      document.querySelector('.begin-lead')!.textContent = lead;
      $('begin-note').textContent = note;
    }
    $('begin-btn').hidden = !!idle.blocked;
    $('begin-note').hidden = !$('begin-note').textContent;
  }
  $('owner-note').hidden = !(isOwner && studioState.phase !== 'idle');
  const canNext = mode === 'live' && connected && isOwner && (studioState.phase === 'working' || studioState.phase === 'resting');
  const rb = $('next-btn') as HTMLButtonElement;
  if (rb.hidden === canNext) { rb.hidden = !canNext; layout(); } // the canvas makes room for the button
  if (nextRequestedAt && nextRequestedAt !== studioPosition()) nextRequestedAt = null; // the studio has moved on
  rb.disabled = !!nextRequestedAt;
}

/** "$14.10 of $100 used": the server's running cost estimate against the spending limit */
function renderSpend(s: Spend) {
  const el = $('spend');
  const usd = (n: number) => `$${n.toFixed(2)}`;
  el.textContent = s.limit > 0 ? `${usd(s.spent)} of $${s.limit} used` : `${usd(s.spent)} spent`;
  el.classList.toggle('warn', s.limit > 0 && s.spent >= s.limit * 0.8 && s.spent < s.limit);
  el.classList.toggle('over', s.limit > 0 && s.spent >= s.limit);
  el.hidden = false;
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => { connected = true; sendMsg({ type: 'identify', tab: TAB }); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data) as ServerMessage;
    if (msg.type === 'hello' || msg.type === 'state') clockOffset = msg.serverTime - Date.now();
    if (msg.type === 'hello' || msg.type === 'spend') renderSpend(msg.spend);
    if (msg.type === 'hello') {
      liveEvents = msg.events;
      studioState = msg.state;
      isOwner = msg.owner;
      if (mode === 'live') startLive();
    } else if (msg.type === 'state') {
      studioState = msg.state;
      isOwner = msg.owner;
      if (msg.state.phase === 'working' && !msg.state.sessionId) liveEvents = [];
      if (mode === 'live' && msg.state.phase === 'resting') showRestingWork(msg.state.lastId);
    } else if (msg.type === 'event') {
      if (msg.event.type === 'session') liveEvents = [];
      liveEvents.push(msg.event);
      if (mode === 'live') {
        if (msg.event.type === 'session') { player.reset(); hideCaption(); }
        player.enqueue(msg.event);
      }
    }
  };
  ws.onclose = async () => {
    connected = false;
    isOwner = false;
    // a refused connection can mean a password was just turned on or changed: go to the login screen
    const auth = await fetch('/api/auth').then((r) => r.json()).catch(() => null) as { ok: boolean } | null;
    if (auth && !auth.ok) { location.reload(); return; }
    setTimeout(connect, 1000);
  };
}

async function startLive() {
  player.replay = false;
  player.speed = 1;
  player.paused = false;
  player.reset();
  stream.innerHTML = '';
  lastBlock = null;
  hideCaption();
  $('transport').hidden = true;
  if (liveEvents.length) {
    $('catching').hidden = false;
    await new Promise((r) => setTimeout(r, 30));
    player.fastForward(liveEvents);
    $('catching').hidden = true;
  } else if (studioState.phase === 'resting') {
    showRestingWork(studioState.lastId);
  }
  layout();
}

async function showRestingWork(id: string | null) {
  if (!id || liveEvents.length) return;
  const events = await fetch(`/api/sessions/${id}/events`).then((r) => r.json()) as StudioEvent[];
  if (mode !== 'live' || liveEvents.length) return;
  player.reset();
  player.fastForward(events);
}

function updateStatus() {
  const el = $('status'), txt = $('status-text');
  el.className = 'status';
  if (mode === 'replay') { txt.textContent = `Replay · No. ${workNumber}`; return; }
  if (!connected) { txt.textContent = 'reconnecting…'; return; }
  if (studioState.phase === 'working') {
    el.classList.add('live');
    const last = liveEvents[liveEvents.length - 1];
    const doing = player.busy ? 'drawing' : last?.type === 'finished' ? 'finished' : 'thinking';
    txt.textContent = `Live · No. ${workNumber || '…'} · ${doing} · ${studioState.work} of ${studioState.of}`;
  } else if (studioState.phase === 'resting') {
    el.classList.add('resting');
    const s = Math.max(0, Math.round((studioState.nextAt - (Date.now() + clockOffset)) / 1000));
    txt.textContent = `Resting · work ${studioState.work} of ${studioState.of} begins in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  } else if (studioState.phase === 'stopping') txt.textContent = 'The studio is closing…';
  else if (studioState.blocked === 'total') txt.textContent = 'Token limit reached';
  else if (studioState.blocked === 'storage') txt.textContent = 'Closed · storage not set up';
  else txt.textContent = studioState.completedRun ? 'Run complete · press Continue for more' : 'The studio is empty';
}

// ------------------------------------------------------------------ replay

async function startReplay(id: string) {
  mode = 'replay';
  const [events, meta] = await Promise.all([
    fetch(`/api/sessions/${id}/events`).then((r) => r.json()) as Promise<StudioEvent[]>,
    fetch(`/api/sessions/${id}/meta`).then((r) => r.json()) as Promise<SessionMeta | null>,
  ]);
  if (mode !== 'replay') return;
  player.reset();
  stream.innerHTML = '';
  lastBlock = null;
  hideCaption();
  player.replay = true;
  player.paused = false;
  setSpeed(3);
  for (const e of events) player.enqueue(e);
  if (meta) $('work-meta').textContent = `No. ${meta.number}`;
  $('transport').hidden = false;
  layout();
}

function setSpeed(s: number) {
  if (s === 0) { player.fastForward(); return; }
  player.speed = s;
  document.querySelectorAll<HTMLButtonElement>('#tp-speeds button').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === s));
}
document.querySelectorAll<HTMLButtonElement>('#tp-speeds button').forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
$('tp-play').addEventListener('click', () => { player.paused = !player.paused; });

function updateTransport() {
  if (mode !== 'replay') return;
  $('tp-play').textContent = player.paused ? '▶' : '❚❚';
  ($('tp-progress') as HTMLInputElement).value = String(player.total ? Math.round((player.processed / player.total) * 1000) : 0);
}

// ------------------------------------------------------------------ gallery

async function showGallery() {
  const list = await fetch('/api/sessions').then((r) => r.json()) as SessionMeta[];
  const done = list.filter((m) => m.status !== 'working' && m.actions > 0); // skip sessions that never made a mark
  $('grid').innerHTML = done.length
    ? done.map((m) => `
      <a class="work" href="#/work/${m.id}">
        <div class="img"><img loading="lazy" src="/api/sessions/${m.id}/thumb.jpg" alt="${esc(m.title ?? 'Unfinished')}"></div>
        <div class="t">${esc(m.title ?? 'Unfinished')}</div>
        <div class="s">No. ${m.number} · ${new Date(m.startedAt).toLocaleDateString()} · ${m.actions} actions</div>
      </a>`).join('')
    : '<p class="empty">Nothing has been made yet.</p>';
}

// ------------------------------------------------------------------ routing

function route() {
  const h = location.hash || '#/';
  const work = h.match(/^#\/work\/([\w-]+)/);
  const view = work ? 'studio' : h.startsWith('#/gallery') ? 'gallery' : h.startsWith('#/about') ? 'about' : 'studio';
  $('studio').hidden = view !== 'studio';
  $('gallery').hidden = view !== 'gallery';
  $('about').hidden = view !== 'about';
  document.querySelectorAll<HTMLAnchorElement>('nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === (work ? 'gallery' : view === 'studio' ? 'live' : view)));
  if (view === 'gallery') showGallery();
  if (work) startReplay(work[1]);
  else if (view === 'studio' && mode !== 'live') { mode = 'live'; startLive(); }
  requestAnimationFrame(layout);
}
window.addEventListener('hashchange', route);

/** Show the password screen until the server accepts us (no-op when the site has no password). */
async function ensureAuth() {
  // if the check itself fails, show the login screen rather than assuming the site is open
  const auth = await fetch('/api/auth').then((r) => r.json()).catch(() => ({ required: true, ok: false })) as { required: boolean; ok: boolean };
  if (auth.ok) return;
  $('login').hidden = false;
  const input = $<HTMLInputElement>('login-pw');
  input.focus();
  await new Promise<void>((resolve) => {
    $('login-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = $('login-form').querySelector('button')!;
      btn.disabled = true;
      $('login-err').textContent = '';
      const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: input.value }) }).catch(() => null);
      btn.disabled = false;
      if (r?.ok) { $('login').hidden = true; resolve(); }
      else { $('login-err').textContent = r ? 'That isn’t it.' : 'Can’t reach the studio — try again.'; input.select(); }
    });
  });
}

await ensureAuth();
await loadFonts();
route();
connect();
