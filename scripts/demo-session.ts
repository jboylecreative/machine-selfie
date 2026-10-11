// Writes a scripted (non-AI) session into the archive by sending tool calls through the same
// tool layer Gemini uses. Handy for testing the viewer/gallery without spending API calls:
//   npx tsx scripts/demo-session.ts && npm run server -- --paused   → open the Gallery
import { StudioDocument } from '../src/engine/document.ts';
import { executeTool, type ToolContext } from '../src/server/tools.ts';
import { Archive } from '../src/server/archive.ts';
import { nodePlatform, loadFonts, encode } from '../src/server/platform.ts';
import { mulberry32 } from '../src/engine/rng.ts';
import type { EventBody, SessionMeta, StudioEvent } from '../src/shared/events.ts';

loadFonts();
const archive = new Archive();
const number = archive.nextNumber();
const id = `${String(number).padStart(4, '0')}-demo${Date.now().toString(36)}`;
const meta: SessionMeta = {
  id, number, model: 'scripted-demo', startedAt: new Date().toISOString(), endedAt: null, title: null, statement: null,
  status: 'working', turns: 0, actions: 0, width: 0, height: 0, tokens: { input: 0, output: 0, thoughts: 0 },
};
const store = archive.create(meta);
let t = 0;
const emit = (e: EventBody) => { t += 500; store.event({ ...e, t } as StudioEvent); };
const doc = new StudioDocument(nodePlatform);
const rng = mulberry32(42);
let seq = 0, layers = 0, tool = '';
const ctx: ToolContext = {
  doc,
  emit(op) { doc.apply(op); emit({ type: 'op', seq: ++seq, tool, op }); },
  nextLayerId: () => `L${++layers}`,
  seed: () => (rng() * 2 ** 32) >>> 0,
  random: rng,
};
const call = (name: string, args: Record<string, unknown>) => {
  tool = name;
  try {
    const out = executeTool(name, args, ctx);
    if (out.kind === 'note') emit({ type: 'note', text: out.note });
    if (out.kind === 'finish') { meta.title = out.title; meta.statement = out.statement; }
  } catch (e) {
    emit({ type: 'tool_error', tool: name, error: (e as Error).message });
  }
};

emit({ type: 'session', id, number, startedAt: meta.startedAt, model: meta.model });
emit({ type: 'turn', n: 1 });
emit({ type: 'thought', text: '**A quiet start**\n\nThis is a scripted demo, not the artist. It exercises the tools so the viewer can be tested without an API key.' });
call('set_canvas', { width: 1100, height: 1400, background: '#ece4d4' });
call('new_layer', { name: 'ground' });
call('fill', { layer: 'ground', gradient: { type: 'linear', x0: 0, y0: 0, x1: 0, y1: 1400, stops: [{ offset: 0, color: '#e9dcc3' }, { offset: 1, color: '#b9a88f' }] } });
call('apply_filter', { layer: 'ground', filter: 'add_noise', amount: 0.06 });
call('sketchbook', { note: 'warm ground. one heavy dark form, low. then a single line that goes somewhere else.' });
emit({ type: 'turn', n: 2 });
emit({ type: 'thought', text: 'Something weighty near the bottom. Charcoal, worked broadly.' });
call('new_layer', { name: 'mass', blend_mode: 'multiply' });
const strokes = Array.from({ length: 14 }, (_, i) => ({ points: [[220 + i * 5, 900 + i * 22, 0.4], [480, 870 + i * 25, 1], [760, 905 + i * 20, 0.8], [880 - i * 4, 960 + i * 18, 0.3]] }));
call('brush_stroke', { layer: 'mass', brush: 'charcoal', color: '#2a2320', size: 46, strokes });
call('smudge', { layer: 'mass', points: [[300, 1000], [500, 1040], [700, 1010]], size: 90, strength: 0.5 });
emit({ type: 'turn', n: 3 });
emit({ type: 'thought', text: 'Now the line. Ink, long, pressure rising and falling.' });
call('new_layer', { name: 'line' });
call('brush_stroke', { layer: 'line', brush: 'ink', color: '#14110f', size: 9, points: [[160, 260, 0.2], [380, 420, 0.9], [520, 380, 0.5], [610, 610, 1], [560, 760, 0.6], [700, 880, 0.3]] });
call('draw_shape', { layer: 'line', shape: 'ellipse', cx: 790, cy: 300, rx: 70, ry: 70, fill: '#c8462c' });
call('new_adjustment_layer', { name: 'warmth', adjustment: { type: 'curves', rgb: [[0, 12], [128, 122], [255, 248]], red: [[0, 0], [128, 138], [255, 255]] } });
call('brush_stroke', { layer: 'nope', brush: 'ink', color: '#000', points: [[0, 0], [10, 10]] }); // shows an error in the stream
emit({ type: 'turn', n: 4 });
call('finish', { title: 'Demo: Weight and Line', statement: 'A scripted test of the studio, not a work by the artist.' });
emit({ type: 'finished', title: meta.title!, statement: meta.statement! });

meta.status = 'finished';
meta.endedAt = new Date().toISOString();
meta.actions = seq; meta.turns = 4; meta.width = doc.width; meta.height = doc.height;
store.saveFile('final.png', await encode(doc.flatten(), 'png'));
store.saveFile('thumb.jpg', await encode(doc.flatten('#ffffff', 640), 'jpeg', 85));
store.saveMeta();
console.log(`wrote demo session ${id} (${seq} ops)`);
