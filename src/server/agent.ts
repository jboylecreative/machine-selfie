// One artwork = one session: the Gemini agent loop. Each turn the model thinks (streamed to
// viewers), calls tools (ops applied + broadcast), then sees the canvas as it now is.

import { GoogleGenAI, ThinkingLevel, type Content, type FunctionCall, type FunctionResponsePart, type Part } from '@google/genai';
import { StudioDocument } from '../engine/document.ts';
import type { Op } from '../engine/ops.ts';
import { ctx2d, src, type Canvas } from '../engine/surface.ts';
import { mulberry32 } from '../engine/rng.ts';
import type { EventBody, SessionMeta, StudioEvent } from '../shared/events.ts';
import { TOOL_DECLARATIONS, ToolError, executeTool, type ToolContext } from './tools.ts';
import { buildSystemPrompt } from './prompt.ts';
import { encode, nodePlatform } from './platform.ts';
import type { Archive } from './archive.ts';

export interface AgentConfig {
  ai: GoogleGenAI;
  model: string;
  thinkingLevel: string;
  temperature: number;
  maxTurns: number;
  maxToolCalls: number;
  viewSize: number; // long edge of the canvas image shown to the model
  rememberPastWorks: boolean; // show the artist its earlier works (off = every work starts fresh)
}

export interface SessionHooks {
  onEvent(e: StudioEvent): void;
  /** aborting stops the session immediately, cancelling any in-flight model call */
  signal: AbortSignal;
}

const KEEP_IMAGES = 3; // most recent canvas views kept in context; older ones are replaced by a note

export async function runSession(cfg: AgentConfig, archive: Archive, hooks: SessionHooks): Promise<SessionMeta> {
  const past = archive.list();
  const number = (past[0]?.number ?? 0) + 1;
  const started = new Date();
  const id = `${String(number).padStart(4, '0')}-${started.toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
  const t0 = Date.now();
  const meta: SessionMeta = {
    id, number, model: cfg.model, startedAt: started.toISOString(), endedAt: null, title: null, statement: null,
    status: 'working', turns: 0, actions: 0, width: 1200, height: 1200, tokens: { input: 0, output: 0, thoughts: 0 },
  };
  const store = archive.create(meta);
  const emit = (e: EventBody) => {
    const ev: StudioEvent = { ...e, t: Date.now() - t0 };
    store.event(ev);
    hooks.onEvent(ev);
  };

  const doc = new StudioDocument(nodePlatform);
  let seq = 0, layerCounter = 0, toolCalls = 0;
  const seedRng = mulberry32((Math.random() * 2 ** 32) >>> 0);
  let currentTool = '';
  const ctx: ToolContext = {
    doc,
    emit(op: Op) {
      try { doc.apply(op); } catch (e) { throw new ToolError((e as Error).message); }
      seq++;
      emit({ type: 'op', seq, tool: currentTool, op });
    },
    nextLayerId: () => {
      let id: string;
      do { id = `L${++layerCounter}`; } while (doc.layers.some((l) => l.id === id));
      return id;
    },
    seed: () => (seedRng() * 2 ** 32) >>> 0,
    random: Math.random,
  };

  emit({ type: 'session', id, number, startedAt: meta.startedAt, model: cfg.model });
  console.log(`\n[studio] session ${id} — work no. ${number} — ${cfg.model}`);

  const memory = cfg.rememberPastWorks ? past : [];
  const systemInstruction = buildSystemPrompt(number, memory, cfg.rememberPastWorks);
  const history: Content[] = [{ role: 'user', parts: await openingParts(doc, memory, archive, cfg) }];

  let finished: { title: string; statement: string } | null = null;
  let endReason = '';
  let idleTurns = 0;

  try {
    for (let turn = 1; turn <= cfg.maxTurns; turn++) {
      if (hooks.signal.aborted) break;
      meta.turns = turn;
      emit({ type: 'turn', n: turn });

      const { parts, calls } = await generate(cfg, systemInstruction, history, emit, meta, hooks.signal);
      history.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });

      if (!calls.length) {
        if (++idleTurns >= 4) { endReason = 'the artist stopped acting'; break; }
        history.push({ role: 'user', parts: [{ text: '(The studio is quiet. The canvas is as you left it. Continue with the tools, or call `finish` if the work is complete.)' }] });
        continue;
      }
      idleTurns = 0;

      // Tool results go back as functionResponse parts only. Anything else appended to this turn
      // (loose text or images) makes Gemini "continue" it as text instead of thinking and acting.
      const responses: { functionResponse: { id?: string; name: string; response: Record<string, unknown>; parts?: FunctionResponsePart[] } }[] = [];
      for (const call of calls) {
        const name = call.name ?? '';
        currentTool = name;
        toolCalls++;
        let response: Record<string, unknown>;
        let attach: FunctionResponsePart[] | undefined;
        try {
          if (toolCalls > cfg.maxToolCalls) throw new ToolError('the session has used up its action budget — call finish');
          const out = executeTool(name, (call.args ?? {}) as Record<string, unknown>, ctx);
          response = out.response;
          if (out.kind === 'note') emit({ type: 'note', text: out.note });
          else if (out.kind === 'chance') emit({ type: 'chance', values: out.values });
          else if (out.kind === 'look') {
            emit({ type: 'look', region: out.region, grid: out.grid });
            response = { ...response, attached_image: `look: ${out.layer ? `layer ${out.layer} alone` : 'composite'}, ${out.region ? `region x=${out.region.x} y=${out.region.y} w=${out.region.width} h=${out.region.height}` : 'full canvas'}${out.grid ? ', with coordinate grid' : ''}` };
            attach = [await imagePart(lookImage(doc, out.region, out.grid, out.layer, cfg.viewSize))];
          } else if (out.kind === 'finish') finished = { title: out.title, statement: out.statement };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          response = { error: msg };
          emit({ type: 'tool_error', tool: name, error: msg });
        }
        responses.push({ functionResponse: { id: call.id, name, response, ...(attach ? { parts: attach } : {}) } });
        if (finished) break;
      }
      meta.actions = seq;
      meta.width = doc.width; meta.height = doc.height;
      store.saveMeta();

      if (finished) break;

      const left = cfg.maxTurns - turn;
      const report = [
        `Turn ${turn} complete. ${doc.describe()}`,
        left <= 5 ? `Note: the studio closes after ${left} more turn${left === 1 ? '' : 's'}. Finish when you're ready.` : '',
      ].filter(Boolean).join('\n');
      // the studio report and the current canvas ride on the last function response
      const last = responses[responses.length - 1].functionResponse;
      const canvasNote = last.parts ? 'the second attached image is the whole canvas as it now is' : 'the attached image is the whole canvas as it now is';
      last.response = { ...last.response, studio: report, canvas: canvasNote };
      last.parts = [...(last.parts ?? []), await imagePart(doc.flatten('#ffffff', cfg.viewSize))];
      history.push({ role: 'user', parts: responses });
      pruneImages(history);
    }
    if (!finished && !endReason && !hooks.signal.aborted) endReason = 'the session reached its turn limit';
  } catch (e) {
    if (!hooks.signal.aborted) {
      endReason = `error: ${(e as Error).message}`;
      console.error('[studio] session error', e);
    }
  }
  if (hooks.signal.aborted && !finished) endReason = 'stopped — the studio was closed';

  meta.endedAt = new Date().toISOString();
  meta.actions = seq;
  if (finished) {
    meta.status = 'finished';
    meta.title = finished.title;
    meta.statement = finished.statement;
    emit({ type: 'finished', title: finished.title, statement: finished.statement });
    console.log(`[studio] finished “${finished.title}” — ${finished.statement}`);
  } else {
    meta.status = 'ended';
    meta.endReason = endReason;
    emit({ type: 'ended', reason: endReason });
    console.log(`[studio] ended: ${endReason}`);
  }
  store.saveFile('final.png', await encode(doc.flatten('#ffffff'), 'png'));
  store.saveFile('thumb.jpg', await encode(doc.flatten('#ffffff', 640), 'jpeg', 85));
  store.saveMeta();
  return meta;
}

// ------------------------------------------------------------------ model call

async function generate(
  cfg: AgentConfig, systemInstruction: string, history: Content[],
  emit: (e: EventBody) => void, meta: SessionMeta, signal: AbortSignal,
): Promise<{ parts: Part[]; calls: FunctionCall[] }> {
  for (let attempt = 0; ; attempt++) {
    const parts: Part[] = [];
    const calls: FunctionCall[] = [];
    try {
      const stream = await cfg.ai.models.generateContentStream({
        model: cfg.model,
        contents: history,
        config: {
          systemInstruction,
          temperature: cfg.temperature,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          thinkingConfig: { includeThoughts: true, thinkingLevel: cfg.thinkingLevel as ThinkingLevel },
          abortSignal: signal,
        },
      });
      let usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined;
      for await (const chunk of stream) {
        if (signal.aborted) break;
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
          parts.push(p);
          if (p.functionCall) calls.push(p.functionCall);
          else if (p.text && p.thought) emit({ type: 'thought', text: p.text });
          else if (p.text) emit({ type: 'speech', text: p.text });
        }
      }
      if (usage) {
        meta.tokens.input += usage.promptTokenCount ?? 0;
        meta.tokens.output += usage.candidatesTokenCount ?? 0;
        meta.tokens.thoughts += usage.thoughtsTokenCount ?? 0;
      }
      return { parts, calls };
    } catch (e) {
      if (signal.aborted) throw e;
      const msg = (e as Error).message ?? String(e);
      const retriable = /\b(429|500|502|503|504)\b|overloaded|unavailable|RESOURCE_EXHAUSTED|fetch failed|ECONNRESET|timeout/i.test(msg);
      if (!retriable || attempt >= 6) throw e;
      const wait = Math.min(90_000, 4000 * 2 ** attempt);
      console.warn(`[studio] model call failed (${msg.slice(0, 160)}); retrying in ${wait / 1000}s`);
      await sleep(wait, signal);
    }
  }
}

// ------------------------------------------------------------------ images for the model

async function imagePart(c: Canvas): Promise<Part & FunctionResponsePart> {
  const buf = await encode(c, 'jpeg', 88);
  return { inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } };
}

function pruneImages(history: Content[]) {
  let seen = 0;
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i].role !== 'user') continue;
    for (const part of history[i].parts ?? []) {
      const fr = part.functionResponse;
      if (!fr?.parts?.length) continue;
      seen += fr.parts.length;
      if (seen > KEEP_IMAGES) {
        delete fr.parts;
        const { canvas: _c, attached_image: _a, ...rest } = fr.response ?? {};
        fr.response = { ...rest, image: '(an earlier view — no longer shown)' };
      }
    }
  }
}

async function openingParts(doc: StudioDocument, past: SessionMeta[], archive: Archive, cfg: AgentConfig): Promise<Part[]> {
  const now = new Date();
  const parts: Part[] = [{
    text: [
      `The studio is open. ${now.toUTCString()}.`,
      doc.describe(),
      'Nothing is required of you. Begin whenever, and however, you choose.',
    ].join('\n'),
  }];
  const recent = past.filter((m) => m.status === 'finished').slice(0, 3);
  if (recent.length) {
    parts.push({ text: 'For your memory, your most recent finished works:' });
    for (const m of recent) {
      const thumb = archive.file(m.id, 'thumb.jpg');
      if (!thumb) continue;
      parts.push({ text: `No. ${m.number}, “${m.title}”` });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: thumb.toString('base64') } });
    }
  }
  parts.push({ text: 'The blank canvas:' });
  parts.push(await imagePart(doc.flatten('#ffffff', cfg.viewSize)));
  return parts;
}

function lookImage(
  doc: StudioDocument, region: { x: number; y: number; width: number; height: number } | null,
  grid: boolean, layerId: string | null, viewSize: number,
): Canvas {
  const r = region ? { x: region.x, y: region.y, w: region.width, h: region.height } : undefined;
  let out: Canvas;
  if (layerId) {
    // isolate one layer over a checkerboard so transparency is legible
    const l = doc.layer(layerId);
    const full = nodePlatform.createCanvas(doc.width, doc.height);
    const c = ctx2d(full);
    for (let y = 0; y < doc.height; y += 16) for (let x = 0; x < doc.width; x += 16) {
      c.fillStyle = ((x + y) / 16) % 2 ? '#d8d8d8' : '#f4f4f4';
      c.fillRect(x, y, 16, 16);
    }
    if (l.canvas) c.drawImage(src(l.canvas), 0, 0);
    const rr = r ?? { x: 0, y: 0, w: doc.width, h: doc.height };
    const zoom = Math.min(viewSize / Math.max(rr.w, rr.h), 8);
    out = nodePlatform.createCanvas(Math.round(rr.w * zoom), Math.round(rr.h * zoom));
    ctx2d(out).drawImage(src(full), rr.x, rr.y, rr.w, rr.h, 0, 0, out.width, out.height);
  } else {
    out = doc.flatten('#ffffff', viewSize, r);
  }
  if (grid) drawGrid(out, r ?? { x: 0, y: 0, w: doc.width, h: doc.height });
  return out;
}

function drawGrid(c: Canvas, r: { x: number; y: number; w: number; h: number }) {
  const ctx = ctx2d(c);
  const scale = c.width / r.w;
  const span = Math.max(r.w, r.h);
  const step = [10, 20, 25, 50, 100, 200, 250, 500].find((s) => span / s <= 14) ?? 500;
  ctx.font = '11px "Space Mono"';
  ctx.lineWidth = 1;
  for (let gx = Math.ceil(r.x / step) * step; gx <= r.x + r.w; gx += step) {
    const px = Math.round((gx - r.x) * scale) + 0.5;
    ctx.strokeStyle = 'rgba(255,0,90,0.45)';
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, c.height); ctx.stroke();
    label(ctx, String(gx), px + 2, 2);
  }
  for (let gy = Math.ceil(r.y / step) * step; gy <= r.y + r.h; gy += step) {
    const py = Math.round((gy - r.y) * scale) + 0.5;
    ctx.strokeStyle = 'rgba(255,0,90,0.45)';
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(c.width, py); ctx.stroke();
    label(ctx, String(gy), 2, py + 2);
  }
}

function label(ctx: CanvasRenderingContext2D, s: string, x: number, y: number) {
  ctx.textBaseline = 'top';
  const w = ctx.measureText(s).width;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(x - 1, y - 1, w + 2, 13);
  ctx.fillStyle = '#c0004a';
  ctx.fillText(s, x, y);
}

/** resolves after ms, or early if the signal aborts */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done);
  });
}
