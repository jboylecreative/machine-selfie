// Renders a sampler of every tool to data/engine-smoke.png — a quick visual check of the engine.
import { writeFile, mkdir } from 'node:fs/promises';
import { StudioDocument } from '../src/engine/document.ts';
import { defaultBrush } from '../src/engine/brushes.ts';
import { BRUSHES, type Op } from '../src/engine/ops.ts';
import { parseColor as c } from '../src/engine/color.ts';
import { nodePlatform, loadFonts, encode } from '../src/server/platform.ts';

loadFonts();
const doc = new StudioDocument(nodePlatform);
const ops: Op[] = [
  { t: 'canvas', width: 1400, height: 1000, background: c('#efe9dc') },
  { t: 'layer.new', id: 'L1', name: 'wash', index: 1, opacity: 1, blend: 'multiply', adjustment: null },
  { t: 'fill', layer: 'L1', region: 'M 900 80 L 1350 80 L 1350 520 L 900 520 Z', opacity: 1, blend: 'normal',
    paint: { gradient: { kind: 'linear', x0: 900, y0: 80, x1: 1350, y1: 520, stops: [{ offset: 0, color: c('#f2b36b') }, { offset: 1, color: c('#4b6fa8') }] } } },
  { t: 'layer.new', id: 'L2', name: 'strokes', index: 2, opacity: 1, blend: 'normal', adjustment: null },
];
BRUSHES.forEach((b, i) => {
  const y = 60 + i * 72;
  ops.push({
    t: 'stroke', layer: 'L2', seed: i + 1, brush: defaultBrush(b), color: c('#1d1b2e'), blend: 'normal', erase: false,
    points: [[60, y, 0.3], [250, y - 25, 1], [480, y + 20, 0.8], [760, y - 10, 0.4]],
  });
});
ops.push(
  { t: 'path', layer: 'L2', d: 'M 950 650 C 1050 560, 1200 560, 1300 700 S 1150 900, 1000 860 Z', fill: { color: c('#c8402a') }, stroke: { color: c('#1d1b2e'), width: 4, cap: 'round', join: 'round', dash: [] }, fillRule: 'nonzero', opacity: 1, blend: 'normal' },
  { t: 'text', layer: 'L2', text: 'Studio\nsampler', x: 1125, y: 300, family: 'Playfair Display', weight: 900, italic: true, size: 64, paint: { color: c('#ffffff') }, stroke: null, align: 'center', baseline: 'middle', letterSpacing: 2, lineHeight: 1.0, maxWidth: null, rotation: -6, opacity: 1, blend: 'normal' },
  { t: 'layer.new', id: 'L3', name: 'glow', index: 3, opacity: 1, blend: 'screen', adjustment: null },
  { t: 'stroke', layer: 'L3', seed: 99, brush: { ...defaultBrush('airbrush'), size: 200 }, color: c('#ffcc66'), blend: 'normal', erase: false, points: [[1100, 760], [1200, 720]] },
  { t: 'filter', layer: 'L3', seed: 3, filter: { kind: 'gaussian_blur', radius: 20 }, selection: null },
  { t: 'smudge', layer: 'L2', points: [[200, 200], [260, 300], [330, 380]], size: 50, strength: 0.7, hardness: 0.3 },
  { t: 'layer.new', id: 'A1', name: 'curves', index: 4, opacity: 1, blend: 'normal', adjustment: { kind: 'curves', rgb: [[0, 10], [128, 120], [255, 250]] } },
);
const t0 = performance.now();
for (const op of ops) doc.apply(op);
console.log(`applied ${ops.length} ops in ${(performance.now() - t0).toFixed(0)}ms`);
console.log(doc.describe());
await mkdir('data', { recursive: true });
await writeFile('data/engine-smoke.png', await encode(doc.flatten(), 'png'));
console.log('wrote data/engine-smoke.png');
