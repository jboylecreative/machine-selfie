// The op vocabulary. Ops are normalized (validated, defaults filled, colors parsed) by the
// server's tool layer, applied to the server document, and streamed to viewers who replay
// them progressively. Ops must be deterministic: anything random carries a seed.

import type { RGBA } from './color.ts';

export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'add',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export const BRUSHES = [
  'round', 'airbrush', 'pencil', 'ink', 'charcoal', 'chalk', 'bristle', 'flat', 'watercolor', 'marker', 'spray', 'stipple',
] as const;
export type BrushPreset = (typeof BRUSHES)[number];

export interface GradientStop { offset: number; color: RGBA }
export type Gradient =
  | { kind: 'linear'; x0: number; y0: number; x1: number; y1: number; stops: GradientStop[] }
  | { kind: 'radial'; cx: number; cy: number; r: number; fx?: number; fy?: number; stops: GradientStop[] }
  | { kind: 'conic'; cx: number; cy: number; angle: number; stops: GradientStop[] };

export type Paint = { color: RGBA } | { gradient: Gradient };

export interface BrushSpec {
  preset: BrushPreset;
  size: number;        // diameter px at full pressure
  opacity: number;     // 0..1 max stroke opacity
  flow: number;        // 0..1 per-dab alpha
  hardness: number;    // 0..1 edge hardness
  spacing: number;     // dab spacing as fraction of diameter
  angle: number;       // degrees, for flat/calligraphic tips
  roundness: number;   // 0.05..1 tip aspect
  jitter: number;      // 0..1 size/position/angle randomness
  taper: [number, number]; // px length of start/end taper
}

export interface StrokeOp {
  t: 'stroke'; layer: string; seed: number;
  brush: BrushSpec; color: RGBA; blend: BlendMode; erase: boolean;
  points?: number[][];        // [x,y] or [x,y,pressure] control points, smoothed
  path?: string;              // or SVG path data
  pressure?: number[];        // pressure profile along a path stroke
  selection?: string;         // SVG path limiting where paint lands
}

export interface SmudgeOp {
  t: 'smudge'; layer: string; points: number[][]; size: number; strength: number; hardness: number;
}

export interface ShapeStroke { color: RGBA; width: number; cap: CanvasLineCap; join: CanvasLineJoin; dash: number[] }
export interface PathOp {
  t: 'path'; layer: string; d: string;
  fill: Paint | null; stroke: ShapeStroke | null;
  fillRule: CanvasFillRule; opacity: number; blend: BlendMode;
}

export interface FillOp {
  t: 'fill'; layer: string; paint: Paint; region: string | null; opacity: number; blend: BlendMode;
}

export interface FloodOp {
  t: 'flood'; layer: string; x: number; y: number; color: RGBA; tolerance: number; sampleAll: boolean; opacity: number;
}

export interface TextOp {
  t: 'text'; layer: string; text: string; x: number; y: number;
  family: string; weight: number; italic: boolean; size: number;
  paint: Paint; stroke: { color: RGBA; width: number } | null;
  align: CanvasTextAlign; baseline: 'top' | 'middle' | 'alphabetic' | 'bottom';
  letterSpacing: number; lineHeight: number; maxWidth: number | null; rotation: number;
  opacity: number; blend: BlendMode;
}

export type FilterSpec =
  | { kind: 'gaussian_blur'; radius: number }
  | { kind: 'motion_blur'; distance: number; angle: number }
  | { kind: 'add_noise'; amount: number; monochrome: boolean }
  | { kind: 'unsharp_mask'; radius: number; amount: number }
  | { kind: 'pixelate'; cell: number }
  | { kind: 'ripple'; amplitude: number; wavelength: number; angle: number }
  | { kind: 'twirl'; cx: number; cy: number; radius: number; angle: number }
  | { kind: 'turbulence'; amount: number; scale: number }
  | { kind: 'glow'; radius: number; intensity: number }
  | { kind: 'halftone'; cell: number; angle: number }
  | { kind: 'clouds'; color_a: RGBA; color_b: RGBA; scale: number; detail: number }
  | { kind: 'emboss'; angle: number; strength: number }
  | { kind: 'find_edges'; strength: number };

export interface FilterOp { t: 'filter'; layer: string; seed: number; filter: FilterSpec; selection: string | null }

export interface TransformOp {
  t: 'transform'; layer: string;
  dx: number; dy: number; rotate: number; scaleX: number; scaleY: number; cx: number; cy: number;
}

export type Adjustment =
  | { kind: 'curves'; rgb?: number[][]; r?: number[][]; g?: number[][]; b?: number[][] }
  | { kind: 'levels'; in_black: number; in_white: number; gamma: number; out_black: number; out_white: number }
  | { kind: 'hue_saturation'; hue: number; saturation: number; lightness: number; colorize: boolean }
  | { kind: 'color_balance'; shadows: number[]; midtones: number[]; highlights: number[] }
  | { kind: 'brightness_contrast'; brightness: number; contrast: number }
  | { kind: 'gradient_map'; stops: GradientStop[] }
  | { kind: 'posterize'; levels: number }
  | { kind: 'threshold'; level: number }
  | { kind: 'invert' }
  | { kind: 'black_white' }
  | { kind: 'photo_filter'; color: RGBA; density: number }
  | { kind: 'vibrance'; amount: number };

export interface LayerProps {
  name?: string; opacity?: number; blend?: BlendMode; visible?: boolean;
  alphaLock?: boolean; clip?: boolean; adjustment?: Adjustment;
}

export type Op =
  | { t: 'canvas'; width: number; height: number; background: RGBA | null }
  | { t: 'layer.new'; id: string; name: string; index: number; opacity: number; blend: BlendMode; adjustment: Adjustment | null }
  | { t: 'layer.set'; id: string; props: LayerProps }
  | { t: 'layer.move'; id: string; index: number }
  | { t: 'layer.delete'; id: string }
  | { t: 'layer.duplicate'; id: string; newId: string; name: string }
  | { t: 'layer.merge'; id: string }
  | { t: 'layer.clear'; id: string }
  | StrokeOp | SmudgeOp | PathOp | FillOp | FloodOp | TextOp | FilterOp | TransformOp;
