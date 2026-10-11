// Brush engine: turns a stroke op into a sequence of "steps", each a handful of dabs
// (stamped tip images). Steps are what viewers watch appear one after another.

import type { BrushPreset, BrushSpec, StrokeOp } from './ops.ts';
import { mulberry32, makeNoise2D, type Rng } from './rng.ts';
import { parseSvgPath, smoothThrough, densify } from './geom.ts';
import { ctx2d, type Canvas, type Platform } from './surface.ts';

export type TipKind = 'round' | 'grain' | 'wet';

export interface Dab { x: number; y: number; r: number; angle: number; roundness: number; alpha: number; tip: TipKind; hardness: number; variant: number }
interface Hair { u: number; a: number; dry: number; w: number; k: number }
export interface Step { x: number; y: number; r: number; dabs: Dab[] }

interface PresetDef {
  tip: TipKind | 'bristle' | 'spray' | 'stipple';
  sizeMin: number;   // diameter fraction at zero pressure
  alphaMin: number;  // alpha fraction at zero pressure
  grain: number;     // paper grain strength 0..1
  defaults: Partial<BrushSpec>;
}

export const PRESETS: Record<BrushPreset, PresetDef> = {
  round:      { tip: 'round', sizeMin: 0.35, alphaMin: 1, grain: 0, defaults: { size: 12, hardness: 0.8, flow: 1, spacing: 0.08 } },
  airbrush:   { tip: 'round', sizeMin: 1, alphaMin: 0, grain: 0, defaults: { size: 120, hardness: 0, flow: 0.08, spacing: 0.06 } },
  pencil:     { tip: 'round', sizeMin: 0.6, alphaMin: 0.25, grain: 0.6, defaults: { size: 3, hardness: 0.85, flow: 0.8, spacing: 0.12, jitter: 0.1 } },
  ink:        { tip: 'round', sizeMin: 0.12, alphaMin: 1, grain: 0, defaults: { size: 8, hardness: 0.97, flow: 1, spacing: 0.04 } },
  charcoal:   { tip: 'grain', sizeMin: 0.45, alphaMin: 0.35, grain: 0.75, defaults: { size: 22, hardness: 0.55, flow: 0.55, spacing: 0.1, jitter: 0.35 } },
  chalk:      { tip: 'grain', sizeMin: 0.7, alphaMin: 0.4, grain: 0.85, defaults: { size: 28, hardness: 0.45, flow: 0.7, spacing: 0.1, jitter: 0.5 } },
  bristle:    { tip: 'bristle', sizeMin: 0.55, alphaMin: 0.5, grain: 0.15, defaults: { size: 36, hardness: 0.9, flow: 0.75, spacing: 0.05, jitter: 0.25 } },
  flat:       { tip: 'round', sizeMin: 0.4, alphaMin: 1, grain: 0, defaults: { size: 24, hardness: 0.92, flow: 1, spacing: 0.04, roundness: 0.18, angle: 40 } },
  watercolor: { tip: 'wet', sizeMin: 0.7, alphaMin: 0.4, grain: 0.25, defaults: { size: 60, hardness: 0.35, flow: 0.18, spacing: 0.1, jitter: 0.3, opacity: 0.8 } },
  marker:     { tip: 'round', sizeMin: 0.9, alphaMin: 1, grain: 0, defaults: { size: 18, hardness: 0.85, flow: 1, spacing: 0.04, opacity: 0.7 } },
  spray:      { tip: 'spray', sizeMin: 0.8, alphaMin: 0.3, grain: 0, defaults: { size: 70, hardness: 1, flow: 0.8, spacing: 0.3 } },
  stipple:    { tip: 'stipple', sizeMin: 0.7, alphaMin: 0.6, grain: 0, defaults: { size: 30, hardness: 0.9, flow: 1, spacing: 0.5 } },
};

export function defaultBrush(preset: BrushPreset): BrushSpec {
  const d = PRESETS[preset].defaults;
  const size = d.size ?? 12;
  return {
    preset,
    size,
    opacity: d.opacity ?? 1,
    flow: d.flow ?? 1,
    hardness: d.hardness ?? 0.8,
    spacing: d.spacing ?? 0.08,
    angle: d.angle ?? 0,
    roundness: d.roundness ?? 1,
    jitter: d.jitter ?? 0,
    taper: preset === 'ink' || preset === 'flat' ? [size * 3, size * 5] : preset === 'round' || preset === 'pencil' ? [size * 1.5, size * 2] : [0, 0],
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Dense [x,y,p] samples for each pen-down segment of the stroke. */
export function strokeSamples(op: StrokeOp): number[][][] {
  if (op.path) {
    const lines = parseSvgPath(op.path);
    const segs = lines.map((l) => densify(l.pts.map((p) => [p[0], p[1], 1]), 1));
    const total = segs.reduce((s, seg) => s + arcLen(seg), 0);
    const prof = op.pressure?.length ? op.pressure : null;
    let acc = 0;
    for (const seg of segs) {
      for (let i = 0; i < seg.length; i++) {
        if (i) acc += Math.hypot(seg[i][0] - seg[i - 1][0], seg[i][1] - seg[i - 1][1]);
        seg[i][2] = prof ? sampleProfile(prof, total ? acc / total : 0) : 1;
      }
    }
    return segs;
  }
  const pts = (op.points ?? []).map((p) => [p[0], p[1], p[2] ?? 1]);
  if (!pts.length) return [];
  if (pts.length === 1) return [[pts[0]]];
  return [smoothThrough(pts, 1)];
}

function sampleProfile(prof: number[], t: number) {
  if (prof.length === 1) return prof[0];
  const f = t * (prof.length - 1);
  const i = Math.min(prof.length - 2, Math.floor(f));
  return lerp(prof[i], prof[i + 1], f - i);
}

function arcLen(seg: number[][]) {
  let L = 0;
  for (let i = 1; i < seg.length; i++) L += Math.hypot(seg[i][0] - seg[i - 1][0], seg[i][1] - seg[i - 1][1]);
  return L;
}

export function computeSteps(op: StrokeOp): { steps: Step[]; length: number; grain: number } {
  const b = op.brush;
  const def = PRESETS[b.preset];
  const rng = mulberry32(op.seed);
  const segs = strokeSamples(op);
  const total = segs.reduce((s, seg) => s + arcLen(seg), 0);
  const steps: Step[] = [];

  // bristle setup: each hair keeps its offset and dryness for the whole stroke
  const hairs = def.tip === 'bristle'
    ? Array.from({ length: Math.round(Math.min(48, Math.max(8, b.size / 2.2))) }, (_, k) => ({
        u: rng() - 0.5, a: 0.35 + rng() * 0.65, dry: rng() * 0.9, w: 0.6 + rng() * 0.8, k,
      }))
    : [];
  const streaks = makeNoise2D(op.seed ^ 0x5bd1);

  let acc = 0;
  for (const seg of segs) {
    let next = acc; // place a dab at the very start of each segment
    for (let i = 0; i < seg.length; i++) {
      if (i) acc += Math.hypot(seg[i][0] - seg[i - 1][0], seg[i][1] - seg[i - 1][1]);
      if (acc < next && !(i === seg.length - 1 && seg.length === 1)) continue;
      const [x, y, p0] = seg[i];
      let p = Math.max(0, Math.min(1, p0));
      if (b.taper[0] > 0) p *= lerp(0.08, 1, smooth(acc / b.taper[0]));
      if (b.taper[1] > 0) p *= lerp(0.08, 1, smooth((total - acc) / b.taper[1]));
      const diam = Math.max(0.5, b.size * lerp(def.sizeMin, 1, p));
      const alphaP = lerp(def.alphaMin, 1, p);
      const a = seg[Math.max(0, i - 2)], c = seg[Math.min(seg.length - 1, i + 2)];
      const dir = Math.atan2(c[1] - a[1], c[0] - a[0]);
      steps.push(makeStep(b, def, rng, x, y, diam, alphaP, dir, hairs, total ? acc / total : 0, acc, streaks.noise));
      next = acc + Math.max(0.35, b.spacing * diam);
    }
  }
  return { steps, length: total, grain: def.grain };
}

function makeStep(
  b: BrushSpec, def: PresetDef, rng: Rng, x: number, y: number, diam: number, alphaP: number,
  dir: number, hairs: Hair[], t: number, s: number, noise: (x: number, y: number) => number,
): Step {
  const j = b.jitter;
  const r = diam / 2;
  const dabs: Dab[] = [];
  const base = { roundness: b.roundness, hardness: b.hardness, variant: 0 };
  if (def.tip === 'bristle') {
    const nx = -Math.sin(dir), ny = Math.cos(dir);
    for (const h of hairs) {
      if (Math.abs(h.u) * 2 > alphaP + 0.35) continue; // light pressure: only central hairs touch
      const dryness = 1 - h.dry * smooth((t - 0.25) / 0.75);
      // pigment load varies along each hair → streaky, broken marks
      const streak = smooth((noise(s / 30, h.k * 3.7) - 0.3) / 0.45);
      const alpha = b.flow * 0.6 * h.a * alphaP * dryness * (0.15 + 0.85 * streak);
      if (alpha < 0.01) continue;
      const off = h.u * diam + (rng() - 0.5) * j * 1.5;
      const hr = Math.max(0.5, (diam / hairs.length) * 1.4 * h.w);
      dabs.push({ ...base, tip: 'round', x: x + nx * off, y: y + ny * off, r: hr, angle: 0, roundness: 1, alpha, hardness: 0.85 });
    }
  } else if (def.tip === 'spray') {
    const n = Math.max(4, Math.round(diam * 0.5));
    for (let k = 0; k < n; k++) {
      const ang = rng() * Math.PI * 2, rad = Math.sqrt(rng()) * r * (0.6 + 0.4 * rng());
      dabs.push({ ...base, tip: 'round', x: x + Math.cos(ang) * rad, y: y + Math.sin(ang) * rad, r: 0.4 + rng() * 1.1, angle: 0, roundness: 1, alpha: b.flow * alphaP * (0.4 + 0.6 * rng()), hardness: 0.7 });
    }
  } else if (def.tip === 'stipple') {
    const ang = rng() * Math.PI * 2, rad = Math.sqrt(rng()) * r;
    dabs.push({ ...base, tip: 'round', x: x + Math.cos(ang) * rad, y: y + Math.sin(ang) * rad, r: Math.max(0.6, diam * 0.09 * (0.6 + 0.8 * rng())), angle: 0, roundness: 1, alpha: b.flow * alphaP, hardness: 0.85 });
  } else {
    const sj = 1 + (rng() - 0.5) * j * 0.8;
    const pj = j * r * 0.35;
    const angle = (b.roundness < 1 ? (b.angle * Math.PI) / 180 : dir) + (rng() - 0.5) * j * (b.roundness < 1 ? 0.3 : Math.PI * 2);
    dabs.push({
      ...base, tip: def.tip, x: x + (rng() - 0.5) * pj, y: y + (rng() - 0.5) * pj, r: r * sj, angle,
      alpha: Math.min(1, b.flow * alphaP * (1 - j * 0.3 * rng())), variant: Math.floor(rng() * 4),
    });
  }
  return { x, y, r, dabs };
}

// ---------------------------------------------------------------- tips & grain (cached per platform)

const TIP = 128;

export class TipCache {
  private tips = new Map<string, Canvas>();
  private tinted = new Map<string, Canvas>();
  private grains = new Map<number, CanvasPattern>();
  constructor(private platform: Platform) {}

  tip(kind: TipKind, hardness: number, variant: number): Canvas {
    const h = Math.round(hardness * 20) / 20;
    const key = `${kind}:${h}:${kind === 'round' ? 0 : variant}`;
    let c = this.tips.get(key);
    if (!c) { c = renderTip(this.platform, kind, h, variant); this.tips.set(key, c); }
    return c;
  }

  /** Tip filled with an opaque color, alpha carried in the tip mask. */
  tintedTip(kind: TipKind, hardness: number, variant: number, rgb: string): Canvas {
    const h = Math.round(hardness * 20) / 20;
    const key = `${kind}:${h}:${kind === 'round' ? 0 : variant}:${rgb}`;
    let c = this.tinted.get(key);
    if (!c) {
      if (this.tinted.size > 400) this.tinted.clear();
      c = this.platform.createCanvas(TIP, TIP);
      const ctx = ctx2d(c);
      ctx.drawImage(this.tip(kind, h, variant) as unknown as CanvasImageSource, 0, 0);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = rgb;
      ctx.fillRect(0, 0, TIP, TIP);
      this.tinted.set(key, c);
    }
    return c;
  }

  /** Paper grain: a tiling alpha mask that textured brushes are filtered through. */
  grain(strength: number, ctx: CanvasRenderingContext2D): CanvasPattern {
    const s = Math.round(strength * 20) / 20;
    let pat = this.grains.get(s);
    if (!pat) {
      const N = 256;
      const c = this.platform.createCanvas(N, N);
      const g = ctx2d(c);
      const img = g.createImageData(N, N);
      const { noise } = makeNoise2D(7919);
      const rng = mulberry32(104729);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        // tileable: blend noise at wrapped coords
        const fx = x / N, fy = y / N;
        const n = (u: number, v: number) => noise(u * 64, v * 64) * 0.6 + noise(u * 16, v * 16) * 0.25 + rng() * 0.15;
        const v = lerp(lerp(n(fx, fy), n(fx - 1, fy), fx), lerp(n(fx, fy - 1), n(fx - 1, fy - 1), fx), fy);
        const tooth = smooth((v - 0.25) / 0.5);
        const i = (y * N + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
        img.data[i + 3] = Math.round(255 * (1 - s * (1 - tooth)));
      }
      g.putImageData(img, 0, 0);
      pat = ctx.createPattern(c as unknown as CanvasImageSource, 'repeat')!;
      this.grains.set(s, pat);
    }
    return pat;
  }
}

function renderTip(platform: Platform, kind: TipKind, hardness: number, variant: number): Canvas {
  const c = platform.createCanvas(TIP, TIP);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(TIP, TIP);
  const R = TIP / 2;
  const { fbm } = makeNoise2D(1000 + variant * 31 + (kind === 'wet' ? 500 : 0));
  const rng = mulberry32(77 + variant);
  const hard = Math.min(0.999, hardness);
  for (let y = 0; y < TIP; y++) for (let x = 0; x < TIP; x++) {
    const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
    let d = Math.hypot(dx, dy);
    let a: number;
    if (kind === 'round') {
      a = d >= 1 ? 0 : d <= hard ? 1 : 1 - smooth((d - hard) / (1 - hard));
      if (hard < 0.05) a = Math.pow(Math.max(0, 1 - d), 1.6);
    } else if (kind === 'grain') {
      d += (fbm(x / 9, y / 9, 3) - 0.5) * 0.5;
      const edge = d >= 1 ? 0 : d <= hard ? 1 : 1 - smooth((d - hard) / (1 - hard));
      const tooth = smooth((fbm(x / 3.5, y / 3.5, 2) + rng() * 0.25 - 0.42) / 0.3);
      a = edge * tooth;
    } else {
      // wet: pigment pools toward the rim, ragged edge, uneven interior
      d += (fbm(x / 14, y / 14, 4) - 0.5) * 0.35;
      const body = d >= 1 ? 0 : 0.45 + 0.55 * smooth((d - 0.55) / 0.35);
      const fade = d >= 1 ? 0 : 1 - smooth((d - 0.9) / 0.1);
      a = body * fade * (0.75 + 0.25 * fbm(x / 6, y / 6, 3));
    }
    const i = (y * TIP + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function drawDab(ctx: CanvasRenderingContext2D, tips: TipCache, dab: Dab, rgb: string) {
  const tip = tips.tintedTip(dab.tip, dab.hardness, dab.variant, rgb) as unknown as CanvasImageSource;
  const c = Math.cos(dab.angle), s = Math.sin(dab.angle);
  ctx.setTransform(c, s, -s * dab.roundness, c * dab.roundness, dab.x, dab.y);
  ctx.globalAlpha = dab.alpha;
  ctx.drawImage(tip, -dab.r, -dab.r, dab.r * 2, dab.r * 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
