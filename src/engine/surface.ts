// Minimal canvas abstraction so the engine runs in browsers (HTMLCanvasElement) and on the
// server (@napi-rs/canvas, a Skia binding with the same 2D API).

export interface Canvas { width: number; height: number; getContext(id: '2d', opts?: unknown): unknown }
export interface Platform { createCanvas(w: number, h: number): Canvas }

export const ctx2d = (c: Canvas) => c.getContext('2d') as CanvasRenderingContext2D;
export const src = (c: Canvas) => c as unknown as CanvasImageSource;

export function cloneCanvas(p: Platform, c: Canvas): Canvas {
  const out = p.createCanvas(c.width, c.height);
  ctx2d(out).drawImage(src(c), 0, 0);
  return out;
}

export interface Rect { x: number; y: number; w: number; h: number }

export function clampRect(r: { x0: number; y0: number; x1: number; y1: number }, W: number, H: number, pad = 0): Rect | null {
  const x = Math.max(0, Math.floor(r.x0 - pad)), y = Math.max(0, Math.floor(r.y0 - pad));
  const x1 = Math.min(W, Math.ceil(r.x1 + pad)), y1 = Math.min(H, Math.ceil(r.y1 + pad));
  if (x1 <= x || y1 <= y) return null;
  return { x, y, w: x1 - x, h: y1 - y };
}
