// The artist's toolset: Gemini function declarations + translation of calls into engine ops.
// Tool names and parameters deliberately mirror Photoshop vocabulary the model already knows.
// There is deliberately no text tool: the artist's words belong in its thinking, not on the canvas.

import type { FunctionDeclaration } from '@google/genai';
import { parseColor, type RGBA } from '../engine/color.ts';
import { defaultBrush } from '../engine/brushes.ts';
import { BLEND_MODES, BRUSHES, type Adjustment, type BlendMode, type BrushPreset, type FilterSpec, type Gradient, type Op, type Paint, type ShapeStroke } from '../engine/ops.ts';
import { parseSvgPath } from '../engine/geom.ts';
import type { StudioDocument } from '../engine/document.ts';

// ------------------------------------------------------------------ schema helpers

type S = Record<string, unknown>;
const num = (description: string, extra: S = {}): S => ({ type: 'number', description, ...extra });
const int = (description: string, extra: S = {}): S => ({ type: 'integer', description, ...extra });
const str = (description: string, extra: S = {}): S => ({ type: 'string', description, ...extra });
const bool = (description: string): S => ({ type: 'boolean', description });
const enm = (values: readonly string[], description: string): S => ({ type: 'string', enum: [...values], description });
const obj = (properties: S, required: string[] = [], description?: string): S => ({ type: 'object', properties, required, ...(description ? { description } : {}) });
const arr = (items: S, description: string, extra: S = {}): S => ({ type: 'array', items, description, ...extra });

const COLOR = str('Color: hex (#rrggbb or #rrggbbaa), rgb()/rgba(), or hsl()/hsla().');
const LAYER = str('Layer id (e.g. "L3") or exact layer name.');
const BLEND = enm(BLEND_MODES, 'Blend mode.');
const OPACITY = num('Opacity 0–1.', { minimum: 0, maximum: 1 });
const SELECTION = str('Optional SVG path data acting as a selection: paint only lands inside this closed shape.');
const POINT = arr({ type: 'number' }, '[x, y] or [x, y, pressure] — pressure 0–1 (default 1).', { minItems: 2, maxItems: 3 });
const GRADIENT = obj({
  type: enm(['linear', 'radial', 'conic'], 'Gradient type.'),
  x0: num('linear: start x'), y0: num('linear: start y'), x1: num('linear: end x'), y1: num('linear: end y'),
  cx: num('radial/conic: center x'), cy: num('radial/conic: center y'), r: num('radial: radius'),
  fx: num('radial: optional focal point x'), fy: num('radial: optional focal point y'),
  angle: num('conic: start angle in degrees'),
  stops: arr(obj({ offset: num('0–1'), color: COLOR }, ['offset', 'color']), 'Color stops in order.'),
}, ['type', 'stops'], 'A gradient paint.');
const STROKE_PROPS: S = {
  stroke: { ...COLOR, description: 'Outline color (omit for no outline).' },
  stroke_width: num('Outline width px (default 2).'),
  line_cap: enm(['butt', 'round', 'square'], 'Line cap (default round).'),
  line_join: enm(['miter', 'round', 'bevel'], 'Line join (default round).'),
  dash: arr({ type: 'number' }, 'Optional dash pattern, e.g. [12, 6].'),
};
const FILL_PROPS: S = {
  fill: { ...COLOR, description: 'Fill color (omit for no fill).' },
  fill_gradient: { ...GRADIENT, description: 'Gradient fill instead of a flat fill color.' },
  fill_rule: enm(['nonzero', 'evenodd'], 'Fill rule (default nonzero).'),
  opacity: OPACITY,
  blend_mode: BLEND,
};

const ADJUSTMENT = obj({
  type: enm(['curves', 'levels', 'hue_saturation', 'color_balance', 'brightness_contrast', 'gradient_map', 'posterize', 'threshold', 'invert', 'black_white', 'photo_filter', 'vibrance'], 'Adjustment type.'),
  rgb: arr(arr({ type: 'number' }, '[input, output]'), 'curves: master curve points, 0–255 pairs, e.g. [[0,0],[64,40],[192,215],[255,255]].'),
  red: arr(arr({ type: 'number' }, '[input, output]'), 'curves: red channel points.'),
  green: arr(arr({ type: 'number' }, '[input, output]'), 'curves: green channel points.'),
  blue: arr(arr({ type: 'number' }, '[input, output]'), 'curves: blue channel points.'),
  in_black: num('levels: input black 0–255 (default 0)'), in_white: num('levels: input white (default 255)'),
  gamma: num('levels: midtone gamma (default 1)'), out_black: num('levels: output black (default 0)'), out_white: num('levels: output white (default 255)'),
  hue: num('hue_saturation: hue shift degrees −180..180 (or the hue when colorize)'),
  saturation: num('hue_saturation: −100..100'), lightness: num('hue_saturation: −100..100'), colorize: bool('hue_saturation: tint everything one hue'),
  shadows: arr({ type: 'number' }, 'color_balance: [cyan↔red, magenta↔green, yellow↔blue] each −100..100'),
  midtones: arr({ type: 'number' }, 'color_balance: same for midtones'), highlights: arr({ type: 'number' }, 'color_balance: same for highlights'),
  brightness: num('brightness_contrast: −100..100'), contrast: num('brightness_contrast: −100..100'),
  stops: arr(obj({ offset: num('0–1'), color: COLOR }, ['offset', 'color']), 'gradient_map: luminance → color stops (offset 0 = shadows)'),
  levels: num('posterize: number of levels 2–32'), level: num('threshold: 0–255'),
  color: { ...COLOR, description: 'photo_filter: filter color' }, density: num('photo_filter: 0–1'),
  amount: num('vibrance: −100..100'),
}, ['type'], 'An adjustment (non-destructive color operation on everything below the layer).');

// ------------------------------------------------------------------ declarations

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'set_canvas',
    description: 'Choose the canvas size and paper/background color. Only possible before any marks are made. Default is 1200×1200 white. Max 2048 per side and 2.4 megapixels total. Use background "transparent" for no background layer (the paper then reads as white).',
    parametersJsonSchema: obj({ width: int('Width px (256–2048).'), height: int('Height px (256–2048).'), background: COLOR }, ['width', 'height']),
  },
  {
    name: 'new_layer',
    description: 'Create a new empty pixel layer. By default it goes on top of the stack. Returns its id.',
    parametersJsonSchema: obj({ name: str('Descriptive layer name.'), blend_mode: BLEND, opacity: OPACITY, above: { ...LAYER, description: 'Place directly above this layer.' }, below: { ...LAYER, description: 'Place directly below this layer.' } }, ['name']),
  },
  {
    name: 'new_adjustment_layer',
    description: 'Create a non-destructive adjustment layer (curves, levels, hue/saturation, color balance, gradient map, etc.) that alters the look of everything beneath it. Change it later with set_layer.',
    parametersJsonSchema: obj({ name: str('Layer name.'), adjustment: ADJUSTMENT, blend_mode: BLEND, opacity: OPACITY, above: LAYER, below: LAYER }, ['adjustment']),
  },
  {
    name: 'set_layer',
    description: 'Change a layer\'s properties: name, opacity, blend mode, visibility, alpha lock (paint only where pixels already exist — ideal for shading within a shape), clipping (clip_to_below: show only where the layer beneath has pixels), or replace an adjustment layer\'s settings.',
    parametersJsonSchema: obj({ layer: LAYER, name: str('New name.'), opacity: OPACITY, blend_mode: BLEND, visible: bool('Show/hide.'), alpha_lock: bool('Lock transparent pixels.'), clip_to_below: bool('Clipping mask to the layer below.'), adjustment: ADJUSTMENT }, ['layer']),
  },
  {
    name: 'arrange_layer',
    description: 'Move a layer in the stack.',
    parametersJsonSchema: obj({ layer: LAYER, to: enm(['top', 'bottom', 'up', 'down'], 'Where to move it.'), above: LAYER, below: LAYER }, ['layer']),
  },
  {
    name: 'layer_action',
    description: 'delete a layer, duplicate it (copy placed above), merge_down into the pixel layer beneath, or clear its pixels.',
    parametersJsonSchema: obj({ layer: LAYER, action: enm(['delete', 'duplicate', 'merge_down', 'clear'], 'Action.'), name: str('Name for the duplicate.') }, ['layer', 'action']),
  },
  {
    name: 'brush_stroke',
    description: 'Paint freehand stroke(s) with a natural-media brush. Give the stroke as `points` (a smooth curve is drawn through them; add pressure as a 3rd value) or as SVG `path` data. To make many strokes with the same brush in one call (hatching, foliage, texture), pass `strokes` instead. Watchers see each stroke drawn in real time.',
    parametersJsonSchema: obj({
      layer: LAYER,
      brush: enm(BRUSHES, 'Brush preset.'),
      color: COLOR,
      size: num('Diameter px at full pressure (preset default if omitted).'),
      opacity: OPACITY,
      flow: num('Per-dab paint flow 0–1; low flow builds up gradually.'),
      hardness: num('Edge hardness 0–1.'),
      spacing: num('Dab spacing as a fraction of size (e.g. 0.05 smooth, 0.5 dotted).'),
      angle: num('Tip angle in degrees (flat/calligraphic tips).'),
      roundness: num('Tip roundness 0.05–1 (lower = flatter, calligraphic).'),
      jitter: num('Randomness of size/position/angle 0–1.'),
      taper_start: num('Taper length px at the start (0 = none).'),
      taper_end: num('Taper length px at the end.'),
      blend_mode: BLEND,
      erase: bool('Erase instead of paint (uses the brush shape).'),
      selection: SELECTION,
      points: arr(POINT, 'Control points for a single stroke.'),
      path: str('SVG path data for a single stroke (alternative to points).'),
      pressure: arr({ type: 'number' }, 'Pressure profile 0–1 along a `path` stroke, evenly spaced from start to end.'),
      strokes: arr(obj({ points: arr(POINT, 'Control points.'), path: str('SVG path data.'), pressure: arr({ type: 'number' }, 'Pressure profile along path.') }), 'Several strokes with the same brush, drawn in order (max 60).'),
    }, ['layer', 'brush', 'color']),
  },
  {
    name: 'smudge',
    description: 'Smudge/smear existing pixels on a layer along a path, like dragging a finger through wet paint.',
    parametersJsonSchema: obj({ layer: LAYER, points: arr(POINT, 'Path of the smudge.'), size: num('Diameter px (default 40).'), strength: num('0–1 (default 0.6).'), hardness: num('0–1 (default 0.3).') }, ['layer', 'points']),
  },
  {
    name: 'draw_path',
    description: 'Draw a precise vector shape from SVG path data (M, L, H, V, C, S, Q, T, A, Z; absolute or relative), with a fill and/or outline. Watchers see the outline drawn, then the fill.',
    parametersJsonSchema: obj({ layer: LAYER, d: str('SVG path data.'), ...FILL_PROPS, ...STROKE_PROPS }, ['layer', 'd']),
  },
  {
    name: 'draw_shape',
    description: 'Draw a geometric shape: rect (x, y, width, height, corner_radius), ellipse (cx, cy, rx, ry), polygon (cx, cy, radius, sides), star (cx, cy, radius, inner_radius, points), line (x, y, x2, y2). All accept rotation (degrees, around the shape center).',
    parametersJsonSchema: obj({
      layer: LAYER, shape: enm(['rect', 'ellipse', 'polygon', 'star', 'line'], 'Shape type.'),
      x: num('rect/line: x'), y: num('rect/line: y'), width: num('rect: width'), height: num('rect: height'), corner_radius: num('rect: corner radius'),
      x2: num('line: end x'), y2: num('line: end y'),
      cx: num('center x'), cy: num('center y'), rx: num('ellipse: x radius'), ry: num('ellipse: y radius'),
      radius: num('polygon/star: outer radius'), inner_radius: num('star: inner radius'), sides: int('polygon: sides'), points: int('star: number of points'),
      rotation: num('Rotation in degrees.'),
      ...FILL_PROPS, ...STROKE_PROPS,
    }, ['layer', 'shape']),
  },
  {
    name: 'fill',
    description: 'Fill a whole layer, or a region given as SVG path data, with a flat color or a gradient.',
    parametersJsonSchema: obj({ layer: LAYER, color: COLOR, gradient: GRADIENT, region: str('Optional SVG path data limiting the fill.'), opacity: OPACITY, blend_mode: BLEND }, ['layer']),
  },
  {
    name: 'bucket_fill',
    description: 'Paint-bucket: flood-fill the contiguous area around (x, y) with a color, bounded by color differences — e.g. fill inside line work.',
    parametersJsonSchema: obj({ layer: LAYER, x: num('x'), y: num('y'), color: COLOR, tolerance: num('0–100 color tolerance (default 20).'), sample_all_layers: bool('Detect boundaries from the visible image rather than just this layer.'), opacity: OPACITY }, ['layer', 'x', 'y', 'color']),
  },
  {
    name: 'apply_filter',
    description: [
      'Apply a destructive filter to a layer\'s pixels (optionally only inside a selection). Filters and their parameters:',
      'gaussian_blur(radius) · motion_blur(distance, angle) · add_noise(amount 0–1, monochrome) · unsharp_mask(radius, amount) · pixelate(cell) ·',
      'ripple(amplitude, wavelength, angle) · twirl(cx, cy, radius, angle) · turbulence(amount px, scale px) · glow(radius, intensity) ·',
      'halftone(cell, angle) · clouds(color_a, color_b, scale, detail) — replaces the layer with fractal noise · emboss(angle, strength) · find_edges(strength).',
    ].join(' '),
    parametersJsonSchema: obj({
      layer: LAYER, filter: enm(['gaussian_blur', 'motion_blur', 'add_noise', 'unsharp_mask', 'pixelate', 'ripple', 'twirl', 'turbulence', 'glow', 'halftone', 'clouds', 'emboss', 'find_edges'], 'Filter.'),
      radius: num('blur/glow/unsharp/twirl radius px'), distance: num('motion_blur distance px'), angle: num('degrees'),
      amount: num('noise 0–1 / unsharp amount / turbulence px'), monochrome: bool('noise: monochrome'), cell: num('pixelate/halftone cell px'),
      amplitude: num('ripple amplitude px'), wavelength: num('ripple wavelength px'), cx: num('twirl center x'), cy: num('twirl center y'),
      scale: num('turbulence/clouds feature size px'), intensity: num('glow intensity 0–3'), strength: num('emboss/find_edges strength'),
      color_a: COLOR, color_b: COLOR, detail: num('clouds octaves 1–8'), selection: SELECTION,
    }, ['layer', 'filter']),
  },
  {
    name: 'transform_layer',
    description: 'Move, rotate, scale or flip a layer\'s pixels. Rotation/scale happen around the origin point (default: canvas center).',
    parametersJsonSchema: obj({ layer: LAYER, move_x: num('px'), move_y: num('px'), rotate: num('degrees'), scale: num('uniform scale (1 = same)'), scale_x: num('horizontal scale'), scale_y: num('vertical scale'), flip_horizontal: bool('mirror horizontally'), flip_vertical: bool('mirror vertically'), origin_x: num('origin x'), origin_y: num('origin y') }, ['layer']),
  },
  {
    name: 'look',
    description: 'Look closely: returns an image of the whole canvas or a zoomed region, optionally with a labeled coordinate grid to help you place marks precisely. You automatically see the full canvas after every turn; use this for detail or orientation.',
    parametersJsonSchema: obj({ x: num('Region left'), y: num('Region top'), width: num('Region width'), height: num('Region height'), grid: bool('Overlay a coordinate grid.'), layer: { ...LAYER, description: 'Look at a single layer in isolation instead of the composite.' } }),
  },
  {
    name: 'sample_color',
    description: 'Eyedropper: read the visible color at one or more points.',
    parametersJsonSchema: obj({ points: arr(arr({ type: 'number' }, '[x, y]'), 'Points to sample.') }, ['points']),
  },
  {
    name: 'chance',
    description: 'Roll for genuine randomness (you cannot produce it yourself). Returns `count` random numbers between min and max. Use it if you want chance operations in your process; ignore it otherwise.',
    parametersJsonSchema: obj({ count: int('How many (1–50).'), min: num('Minimum (default 0).'), max: num('Maximum (default 1).'), integers: bool('Whole numbers only.') }, ['count']),
  },
  {
    name: 'sketchbook',
    description: 'Write a private note to your future self: intentions, discoveries, decisions, doubts. Notes persist for the whole session, even after older views of the canvas have faded from your memory.',
    parametersJsonSchema: obj({ note: str('The note.') }, ['note']),
  },
  {
    name: 'finish',
    description: 'Declare the work complete. Only call this when you genuinely judge it finished. Ends the session.',
    parametersJsonSchema: obj({ title: str('The title of the work.'), statement: str('A short statement about the work, in your own voice.') }, ['title', 'statement']),
  },
];

// ------------------------------------------------------------------ execution

export interface ToolContext {
  doc: StudioDocument;
  /** Apply an op to the document and broadcast it. Throws if the op is invalid. */
  emit(op: Op): void;
  nextLayerId(): string;
  seed(): number;
  random(): number;
}

export type ToolOutcome =
  | { kind: 'ok'; response: Record<string, unknown> }
  | { kind: 'look'; response: Record<string, unknown>; region: { x: number; y: number; width: number; height: number } | null; grid: boolean; layer: string | null }
  | { kind: 'note'; response: Record<string, unknown>; note: string }
  | { kind: 'chance'; response: Record<string, unknown>; values: number[] }
  | { kind: 'finish'; response: Record<string, unknown>; title: string; statement: string };

class ToolError extends Error {}
const fail = (msg: string): never => { throw new ToolError(msg); };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optNum = (v: unknown, def: number, lo = -Infinity, hi = Infinity) => (isNum(v) ? Math.min(hi, Math.max(lo, v)) : def);
const reqNum = (a: S, k: string) => (isNum(a[k]) ? (a[k] as number) : fail(`"${k}" must be a number`));
const opacityOf = (v: unknown, def = 1) => (isNum(v) ? (v > 1 ? Math.min(100, v) / 100 : Math.max(0, v)) : def);
const color = (v: unknown, field = 'color'): RGBA => { try { return parseColor(v); } catch (e) { return fail(`${field}: ${(e as Error).message}`); } };
const blend = (v: unknown): BlendMode => (v === undefined || v === null ? 'normal' : (BLEND_MODES as readonly string[]).includes(String(v)) ? (v as BlendMode) : fail(`unknown blend mode "${v}"`));
const checkPath = (d: unknown, field: string): string => {
  if (typeof d !== 'string') return fail(`"${field}" must be SVG path data`);
  if (d.length > 40000) fail(`"${field}" is too long`);
  try { parseSvgPath(d); } catch (e) { fail(`${field}: ${(e as Error).message}`); }
  return d;
};

function resolveLayer(doc: StudioDocument, ref: unknown, field = 'layer'): string {
  if (typeof ref !== 'string' || !ref.trim()) return fail(`"${field}" is required`);
  const r = ref.trim().toLowerCase();
  const hit = doc.layers.find((l) => l.id.toLowerCase() === r) ?? doc.layers.find((l) => l.name.toLowerCase() === r);
  if (!hit) fail(`no layer "${ref}". Layers: ${doc.layers.map((l) => `${l.id} "${l.name}"`).join(', ') || 'none'}`);
  return hit!.id;
}

function insertIndex(doc: StudioDocument, a: S): number {
  if (a.above) return doc.layers.findIndex((l) => l.id === resolveLayer(doc, a.above, 'above')) + 1;
  if (a.below) return doc.layers.findIndex((l) => l.id === resolveLayer(doc, a.below, 'below'));
  return doc.layers.length;
}

function gradient(g: unknown, field = 'gradient'): Gradient {
  if (!g || typeof g !== 'object') return fail(`"${field}" must be an object`);
  const o = g as S;
  const rawStops = Array.isArray(o.stops) ? o.stops : fail(`${field}.stops must be an array`);
  if (rawStops.length < 2) fail(`${field} needs at least 2 stops`);
  const stops = rawStops.map((s, i) => {
    if (typeof s === 'string') return { offset: i / (rawStops.length - 1), color: color(s, `${field}.stops`) };
    const so = s as S;
    return { offset: optNum(so.offset, i / (rawStops.length - 1), 0, 1), color: color(so.color, `${field}.stops`) };
  });
  switch (o.type) {
    case 'linear': return { kind: 'linear', x0: reqNum(o, 'x0'), y0: reqNum(o, 'y0'), x1: reqNum(o, 'x1'), y1: reqNum(o, 'y1'), stops };
    case 'radial': return { kind: 'radial', cx: reqNum(o, 'cx'), cy: reqNum(o, 'cy'), r: reqNum(o, 'r'), fx: isNum(o.fx) ? o.fx : undefined, fy: isNum(o.fy) ? o.fy : undefined, stops };
    case 'conic': return { kind: 'conic', cx: reqNum(o, 'cx'), cy: reqNum(o, 'cy'), angle: optNum(o.angle, 0), stops };
    default: return fail(`${field}.type must be linear, radial or conic`);
  }
}

function adjustment(a: unknown): Adjustment {
  if (!a || typeof a !== 'object') return fail('"adjustment" must be an object');
  const o = a as S;
  const pts = (v: unknown) => (Array.isArray(v) ? (v as number[][]).filter((p) => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1])).map((p) => [p[0], p[1]]) : undefined);
  const trip = (v: unknown) => (Array.isArray(v) ? [0, 1, 2].map((i) => optNum(v[i], 0, -100, 100)) : [0, 0, 0]);
  switch (o.type) {
    case 'curves': return { kind: 'curves', rgb: pts(o.rgb), r: pts(o.red), g: pts(o.green), b: pts(o.blue) };
    case 'levels': return { kind: 'levels', in_black: optNum(o.in_black, 0, 0, 254), in_white: optNum(o.in_white, 255, 1, 255), gamma: optNum(o.gamma, 1, 0.1, 9.99), out_black: optNum(o.out_black, 0, 0, 255), out_white: optNum(o.out_white, 255, 0, 255) };
    case 'hue_saturation': return { kind: 'hue_saturation', hue: optNum(o.hue, 0, -360, 360), saturation: optNum(o.saturation, 0, -100, 100), lightness: optNum(o.lightness, 0, -100, 100), colorize: !!o.colorize };
    case 'color_balance': return { kind: 'color_balance', shadows: trip(o.shadows), midtones: trip(o.midtones), highlights: trip(o.highlights) };
    case 'brightness_contrast': return { kind: 'brightness_contrast', brightness: optNum(o.brightness, 0, -100, 100), contrast: optNum(o.contrast, 0, -100, 100) };
    case 'gradient_map': return { kind: 'gradient_map', stops: gradient({ type: 'linear', x0: 0, y0: 0, x1: 1, y1: 0, stops: o.stops }, 'adjustment').stops };
    case 'posterize': return { kind: 'posterize', levels: optNum(o.levels, 4, 2, 32) };
    case 'threshold': return { kind: 'threshold', level: optNum(o.level, 128, 0, 255) };
    case 'invert': return { kind: 'invert' };
    case 'black_white': return { kind: 'black_white' };
    case 'photo_filter': return { kind: 'photo_filter', color: color(o.color ?? '#ec8a00', 'adjustment.color'), density: optNum(o.density, 0.25, 0, 1) };
    case 'vibrance': return { kind: 'vibrance', amount: optNum(o.amount, 25, -100, 100) };
    default: return fail(`unknown adjustment type "${o.type}"`);
  }
}

function fillPaint(a: S, colorKey: string, gradKey: string): Paint | null {
  if (a[gradKey]) return { gradient: gradient(a[gradKey], gradKey) };
  if (a[colorKey] !== undefined && a[colorKey] !== null && a[colorKey] !== '') return { color: color(a[colorKey], colorKey) };
  return null;
}

function shapeStroke(a: S): ShapeStroke | null {
  if (a.stroke === undefined || a.stroke === null || a.stroke === '') return null;
  return {
    color: color(a.stroke, 'stroke'),
    width: optNum(a.stroke_width, 2, 0.1, 500),
    cap: (['butt', 'round', 'square'].includes(a.line_cap as string) ? a.line_cap : 'round') as CanvasLineCap,
    join: (['miter', 'round', 'bevel'].includes(a.line_join as string) ? a.line_join : 'round') as CanvasLineJoin,
    dash: Array.isArray(a.dash) ? (a.dash as unknown[]).filter(isNum).map((v) => Math.max(0, v)).slice(0, 16) : [],
  };
}

function points(v: unknown, field: string, max = 3000): number[][] {
  if (!Array.isArray(v) || !v.length) return fail(`"${field}" must be a non-empty array of [x, y] or [x, y, pressure]`);
  if (v.length > max) fail(`"${field}" has too many points (max ${max})`);
  return v.map((p, i) => {
    if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) return fail(`${field}[${i}] must be [x, y] or [x, y, pressure]`);
    return isNum(p[2]) ? [p[0], p[1], Math.max(0, Math.min(1, p[2]))] : [p[0], p[1]];
  });
}

const fmt = (n: number) => Math.round(n * 10) / 10;

function shapePath(a: S): string {
  const rot = optNum(a.rotation, 0);
  let d: string, cx: number, cy: number;
  switch (a.shape) {
    case 'rect': {
      const x = reqNum(a, 'x'), y = reqNum(a, 'y'), w = reqNum(a, 'width'), h = reqNum(a, 'height');
      const r = Math.min(optNum(a.corner_radius, 0, 0), Math.abs(w) / 2, Math.abs(h) / 2);
      cx = x + w / 2; cy = y + h / 2;
      d = r > 0
        ? `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
        : `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      break;
    }
    case 'ellipse': {
      cx = reqNum(a, 'cx'); cy = reqNum(a, 'cy');
      const rx = isNum(a.rx) ? a.rx : reqNum(a, 'radius'), ry = isNum(a.ry) ? a.ry : rx;
      d = `M${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}Z`;
      break;
    }
    case 'polygon': case 'star': {
      cx = reqNum(a, 'cx'); cy = reqNum(a, 'cy');
      const R = reqNum(a, 'radius');
      const n = a.shape === 'star' ? Math.round(optNum(a.points, 5, 2, 200)) : Math.round(optNum(a.sides, 6, 3, 200));
      const inner = a.shape === 'star' ? optNum(a.inner_radius, R * 0.45, 0) : R;
      const verts: string[] = [];
      const count = a.shape === 'star' ? n * 2 : n;
      for (let i = 0; i < count; i++) {
        const r = a.shape === 'star' && i % 2 ? inner : R;
        const t = -Math.PI / 2 + (i * 2 * Math.PI) / count;
        verts.push(`${fmt(cx + r * Math.cos(t))} ${fmt(cy + r * Math.sin(t))}`);
      }
      d = `M${verts.join('L')}Z`;
      break;
    }
    case 'line': {
      const x = reqNum(a, 'x'), y = reqNum(a, 'y'), x2 = reqNum(a, 'x2'), y2 = reqNum(a, 'y2');
      cx = (x + x2) / 2; cy = (y + y2) / 2;
      d = `M${x} ${y}L${x2} ${y2}`;
      break;
    }
    default: return fail(`unknown shape "${a.shape}"`);
  }
  if (!rot) return d;
  // rotate by flattening and re-emitting the polyline
  const t = (rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return parseSvgPath(d).map((l) => 'M' + l.pts.map(([px, py]) => `${fmt(cx + (px - cx) * c - (py - cy) * s)} ${fmt(cy + (px - cx) * s + (py - cy) * c)}`).join('L') + (l.closed ? 'Z' : '')).join('');
}

function filterSpec(a: S, ctx: ToolContext): FilterSpec {
  const W = ctx.doc.width, H = ctx.doc.height;
  switch (a.filter) {
    case 'gaussian_blur': return { kind: 'gaussian_blur', radius: optNum(a.radius, 6, 0, 250) };
    case 'motion_blur': return { kind: 'motion_blur', distance: optNum(a.distance, 30, 1, 400), angle: optNum(a.angle, 0) };
    case 'add_noise': return { kind: 'add_noise', amount: optNum(a.amount, 0.1, 0, 1), monochrome: a.monochrome !== false };
    case 'unsharp_mask': return { kind: 'unsharp_mask', radius: optNum(a.radius, 2, 0.5, 50), amount: optNum(a.amount, 1, 0, 5) };
    case 'pixelate': return { kind: 'pixelate', cell: optNum(a.cell, 12, 2, 400) };
    case 'ripple': return { kind: 'ripple', amplitude: optNum(a.amplitude, 8, 0, 300), wavelength: optNum(a.wavelength, 60, 2, 2000), angle: optNum(a.angle, 0) };
    case 'twirl': return { kind: 'twirl', cx: optNum(a.cx, W / 2), cy: optNum(a.cy, H / 2), radius: optNum(a.radius, Math.min(W, H) / 3, 1), angle: optNum(a.angle, 90) };
    case 'turbulence': return { kind: 'turbulence', amount: optNum(a.amount, 20, 0, 400), scale: optNum(a.scale, 80, 4, 2000) };
    case 'glow': return { kind: 'glow', radius: optNum(a.radius, 20, 1, 250), intensity: optNum(a.intensity, 1, 0, 3) };
    case 'halftone': return { kind: 'halftone', cell: optNum(a.cell, 10, 3, 200), angle: optNum(a.angle, 45) };
    case 'clouds': return { kind: 'clouds', color_a: color(a.color_a ?? '#000000', 'color_a'), color_b: color(a.color_b ?? '#ffffff', 'color_b'), scale: optNum(a.scale, 200, 8, 4000), detail: optNum(a.detail, 5, 1, 8) };
    case 'emboss': return { kind: 'emboss', angle: optNum(a.angle, 135), strength: optNum(a.strength, 2, 0, 20) };
    case 'find_edges': return { kind: 'find_edges', strength: optNum(a.strength, 1, 0, 10) };
    default: return fail(`unknown filter "${a.filter}"`);
  }
}

export function executeTool(name: string, args: S, ctx: ToolContext): ToolOutcome {
  try {
    return run(name, args ?? {}, ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ToolError(msg);
  }
}

export { ToolError };

function run(name: string, a: S, ctx: ToolContext): ToolOutcome {
  const { doc } = ctx;
  const ok = (response: Record<string, unknown> = { ok: true }): ToolOutcome => ({ kind: 'ok', response });

  switch (name) {
    case 'set_canvas': {
      if (doc.marks > 0) fail('the canvas size can only be set before any marks are made');
      const w = Math.round(reqNum(a, 'width')), h = Math.round(reqNum(a, 'height'));
      if (w < 256 || h < 256 || w > 2048 || h > 2048) fail('width and height must be between 256 and 2048');
      if (w * h > 2_400_000) fail('canvas too large: max 2.4 megapixels');
      const bg = a.background === undefined ? parseColor('#ffffff') : color(a.background, 'background');
      ctx.emit({ t: 'canvas', width: w, height: h, background: bg[3] > 0 ? bg : null });
      return ok({ ok: true, width: w, height: h, layers: doc.layers.map((l) => ({ id: l.id, name: l.name })) });
    }
    case 'new_layer': {
      const id = ctx.nextLayerId();
      const nm = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 60) : id;
      ctx.emit({ t: 'layer.new', id, name: nm, index: insertIndex(doc, a), opacity: opacityOf(a.opacity), blend: blend(a.blend_mode), adjustment: null });
      return ok({ ok: true, id, name: nm });
    }
    case 'new_adjustment_layer': {
      const adj = adjustment(a.adjustment);
      const id = ctx.nextLayerId();
      const nm = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 60) : adj.kind.replace('_', ' ');
      ctx.emit({ t: 'layer.new', id, name: nm, index: insertIndex(doc, a), opacity: opacityOf(a.opacity), blend: blend(a.blend_mode), adjustment: adj });
      return ok({ ok: true, id, name: nm });
    }
    case 'set_layer': {
      const id = resolveLayer(doc, a.layer);
      const props: Record<string, unknown> = {};
      if (typeof a.name === 'string') props.name = a.name.slice(0, 60);
      if (a.opacity !== undefined) props.opacity = opacityOf(a.opacity);
      if (a.blend_mode !== undefined) props.blend = blend(a.blend_mode);
      if (typeof a.visible === 'boolean') props.visible = a.visible;
      if (typeof a.alpha_lock === 'boolean') props.alphaLock = a.alpha_lock;
      if (typeof a.clip_to_below === 'boolean') props.clip = a.clip_to_below;
      if (a.adjustment !== undefined) {
        if (doc.layer(id).kind !== 'adjustment') fail('only adjustment layers take an adjustment');
        props.adjustment = adjustment(a.adjustment);
      }
      if (!Object.keys(props).length) fail('nothing to change');
      ctx.emit({ t: 'layer.set', id, props });
      return ok();
    }
    case 'arrange_layer': {
      const id = resolveLayer(doc, a.layer);
      const cur = doc.layers.findIndex((l) => l.id === id);
      let index: number;
      if (a.above) { const t = doc.layers.findIndex((l) => l.id === resolveLayer(doc, a.above, 'above')); index = t >= cur ? t : t + 1; }
      else if (a.below) { const t = doc.layers.findIndex((l) => l.id === resolveLayer(doc, a.below, 'below')); index = t > cur ? t - 1 : t; }
      else if (a.to === 'top') index = doc.layers.length - 1;
      else if (a.to === 'bottom') index = 0;
      else if (a.to === 'up') index = Math.min(doc.layers.length - 1, cur + 1);
      else if (a.to === 'down') index = Math.max(0, cur - 1);
      else return fail('give "to" (top/bottom/up/down) or "above"/"below"');
      ctx.emit({ t: 'layer.move', id, index });
      return ok();
    }
    case 'layer_action': {
      const id = resolveLayer(doc, a.layer);
      switch (a.action) {
        case 'delete': ctx.emit({ t: 'layer.delete', id }); return ok();
        case 'clear': doc.paintLayer(id); ctx.emit({ t: 'layer.clear', id }); return ok();
        case 'merge_down': {
          const i = doc.layers.findIndex((l) => l.id === id);
          if (i === 0) fail('nothing below to merge into');
          if (doc.layers[i].kind !== 'paint' || doc.layers[i - 1].kind !== 'paint') fail('merge_down needs two pixel layers');
          ctx.emit({ t: 'layer.merge', id });
          return ok({ ok: true, merged_into: doc.layers[i - 1].id });
        }
        case 'duplicate': {
          const newId = ctx.nextLayerId();
          const nm = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : `${doc.layer(id).name} copy`;
          ctx.emit({ t: 'layer.duplicate', id, newId, name: nm });
          return ok({ ok: true, id: newId, name: nm });
        }
        default: return fail('action must be delete, duplicate, merge_down or clear');
      }
    }
    case 'brush_stroke': {
      const layer = resolveLayer(doc, a.layer);
      doc.paintLayer(layer);
      const preset = (BRUSHES as readonly string[]).includes(a.brush as string) ? (a.brush as BrushPreset) : fail(`unknown brush "${a.brush}". Brushes: ${BRUSHES.join(', ')}`);
      const base = defaultBrush(preset);
      const size = optNum(a.size, base.size, 0.5, 1000);
      const brush = {
        ...base,
        size,
        opacity: opacityOf(a.opacity, base.opacity),
        flow: optNum(a.flow, base.flow, 0.01, 1),
        hardness: optNum(a.hardness, base.hardness, 0, 1),
        spacing: optNum(a.spacing, base.spacing, 0.01, 5),
        angle: optNum(a.angle, base.angle),
        roundness: optNum(a.roundness, base.roundness, 0.05, 1),
        jitter: optNum(a.jitter, base.jitter, 0, 1),
        taper: [
          optNum(a.taper_start, isNum(a.size) ? base.taper[0] * (size / base.size) : base.taper[0], 0, 5000),
          optNum(a.taper_end, isNum(a.size) ? base.taper[1] * (size / base.size) : base.taper[1], 0, 5000),
        ] as [number, number],
      };
      const col = color(a.color);
      const selection = a.selection ? checkPath(a.selection, 'selection') : undefined;
      const specs: S[] = Array.isArray(a.strokes) && a.strokes.length ? (a.strokes as S[]) : [a];
      if (specs.length > 60) fail('max 60 strokes per call');
      const parsed = specs.map((s, i) => {
        const f = specs.length > 1 ? `strokes[${i}]` : '';
        if (s.path) return { path: checkPath(s.path, `${f}path`), pressure: Array.isArray(s.pressure) ? (s.pressure as unknown[]).filter(isNum).map((p) => Math.max(0, Math.min(1, p))).slice(0, 200) : undefined };
        if (s.points) return { points: points(s.points, `${f}points`) };
        return fail(`${f || 'stroke'}: give "points" or "path"${specs.length === 1 ? ' (or "strokes")' : ''}`);
      });
      for (const p of parsed) {
        ctx.emit({ t: 'stroke', layer, seed: ctx.seed(), brush, color: col, blend: blend(a.blend_mode), erase: !!a.erase, selection, ...p });
      }
      return ok({ ok: true, strokes: parsed.length });
    }
    case 'smudge': {
      const layer = resolveLayer(doc, a.layer);
      ctx.emit({ t: 'smudge', layer, points: points(a.points, 'points'), size: optNum(a.size, 40, 2, 400), strength: optNum(a.strength, 0.6, 0, 1), hardness: optNum(a.hardness, 0.3, 0, 1) });
      return ok();
    }
    case 'draw_path':
    case 'draw_shape': {
      const layer = resolveLayer(doc, a.layer);
      const d = name === 'draw_path' ? checkPath(a.d, 'd') : shapePath(a);
      const fill = fillPaint(a, 'fill', 'fill_gradient');
      const stroke = shapeStroke(a);
      if (!fill && !stroke) fail('give a fill, fill_gradient and/or stroke color — otherwise nothing is drawn');
      ctx.emit({ t: 'path', layer, d, fill, stroke, fillRule: a.fill_rule === 'evenodd' ? 'evenodd' : 'nonzero', opacity: opacityOf(a.opacity), blend: blend(a.blend_mode) });
      return ok();
    }
    case 'fill': {
      const layer = resolveLayer(doc, a.layer);
      const paint = fillPaint(a, 'color', 'gradient') ?? fail('give a color or gradient');
      ctx.emit({ t: 'fill', layer, paint: paint!, region: a.region ? checkPath(a.region, 'region') : null, opacity: opacityOf(a.opacity), blend: blend(a.blend_mode) });
      return ok();
    }
    case 'bucket_fill': {
      const layer = resolveLayer(doc, a.layer);
      ctx.emit({ t: 'flood', layer, x: reqNum(a, 'x'), y: reqNum(a, 'y'), color: color(a.color), tolerance: optNum(a.tolerance, 20, 0, 100), sampleAll: !!a.sample_all_layers, opacity: opacityOf(a.opacity) });
      return ok();
    }
    case 'apply_filter': {
      const layer = resolveLayer(doc, a.layer);
      doc.paintLayer(layer);
      ctx.emit({ t: 'filter', layer, seed: ctx.seed(), filter: filterSpec(a, ctx), selection: a.selection ? checkPath(a.selection, 'selection') : null });
      return ok();
    }
    case 'transform_layer': {
      const layer = resolveLayer(doc, a.layer);
      doc.paintLayer(layer);
      const s = optNum(a.scale, 1, 0.01, 50);
      let sx = optNum(a.scale_x, s, 0.01, 50), sy = optNum(a.scale_y, s, 0.01, 50);
      if (a.flip_horizontal) sx = -sx;
      if (a.flip_vertical) sy = -sy;
      ctx.emit({ t: 'transform', layer, dx: optNum(a.move_x, 0), dy: optNum(a.move_y, 0), rotate: optNum(a.rotate, 0), scaleX: sx, scaleY: sy, cx: optNum(a.origin_x, doc.width / 2), cy: optNum(a.origin_y, doc.height / 2) });
      return ok();
    }
    case 'look': {
      const hasRegion = [a.x, a.y, a.width, a.height].some(isNum);
      let region = null;
      if (hasRegion) {
        const x = Math.max(0, optNum(a.x, 0)), y = Math.max(0, optNum(a.y, 0));
        const width = Math.min(doc.width - x, optNum(a.width, doc.width - x, 8)), height = Math.min(doc.height - y, optNum(a.height, doc.height - y, 8));
        if (width < 8 || height < 8) fail('region is outside the canvas or too small');
        region = { x, y, width, height };
      }
      const layer = a.layer ? resolveLayer(doc, a.layer) : null;
      return { kind: 'look', response: { ok: true, showing: region ?? 'full canvas', layer: layer ?? 'composite' }, region, grid: !!a.grid, layer };
    }
    case 'sample_color': {
      const pts = points(a.points, 'points', 64);
      return ok({ colors: pts.map(([x, y]) => ({ x, y, color: doc.sampleColor(x, y) })) });
    }
    case 'chance': {
      const n = Math.round(optNum(a.count, 1, 1, 50));
      const lo = optNum(a.min, 0), hi = optNum(a.max, 1);
      const values = Array.from({ length: n }, () => {
        const v = lo + ctx.random() * (hi - lo);
        return a.integers ? Math.floor(lo + ctx.random() * (Math.floor(hi) - Math.ceil(lo) + 1)) : Math.round(v * 10000) / 10000;
      });
      return { kind: 'chance', response: { values }, values };
    }
    case 'sketchbook': {
      const note = typeof a.note === 'string' ? a.note.trim().slice(0, 4000) : '';
      if (!note) fail('"note" is empty');
      return { kind: 'note', response: { ok: true }, note };
    }
    case 'finish': {
      const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : '';
      const statement = typeof a.statement === 'string' ? a.statement.trim().slice(0, 3000) : '';
      if (!title) fail('a title is required (it can be "Untitled")');
      if (doc.marks === 0) fail('the canvas is still empty — make at least one mark before finishing');
      return { kind: 'finish', response: { ok: true }, title, statement };
    }
    default:
      return fail(`unknown tool "${name}"`);
  }
}
