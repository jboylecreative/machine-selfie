// Destructive layer filters, implemented in plain JS over ImageData so results are identical
// everywhere. Blurs work in premultiplied alpha to avoid dark fringes.

import type { FilterSpec } from './ops.ts';
import { mulberry32, makeNoise2D } from './rng.ts';

type Img = { data: Uint8ClampedArray; width: number; height: number };

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function applyFilter(img: Img, f: FilterSpec, seed: number): void {
  switch (f.kind) {
    case 'gaussian_blur': return blur(img, f.radius);
    case 'motion_blur': return motionBlur(img, f.distance, f.angle);
    case 'add_noise': return noise(img, f.amount, f.monochrome, seed);
    case 'unsharp_mask': return unsharp(img, f.radius, f.amount);
    case 'pixelate': return pixelate(img, f.cell);
    case 'ripple': return displace(img, (x, y) => {
      const a = (f.angle * Math.PI) / 180, k = (2 * Math.PI) / Math.max(2, f.wavelength);
      const s = Math.sin((x * Math.cos(a) + y * Math.sin(a)) * k) * f.amplitude;
      return [x - Math.sin(a) * s, y + Math.cos(a) * s];
    });
    case 'twirl': return displace(img, (x, y) => {
      const dx = x - f.cx, dy = y - f.cy, d = Math.hypot(dx, dy);
      if (d >= f.radius) return [x, y];
      const t = 1 - d / f.radius, ang = ((f.angle * Math.PI) / 180) * t * t;
      const c = Math.cos(ang), s = Math.sin(ang);
      return [f.cx + dx * c - dy * s, f.cy + dx * s + dy * c];
    });
    case 'turbulence': {
      const n1 = makeNoise2D(seed), n2 = makeNoise2D(seed + 1);
      const sc = Math.max(4, f.scale);
      return displace(img, (x, y) => [
        x + (n1.fbm(x / sc, y / sc, 4) - 0.5) * 2 * f.amount,
        y + (n2.fbm(x / sc, y / sc, 4) - 0.5) * 2 * f.amount,
      ]);
    }
    case 'glow': return glow(img, f.radius, f.intensity);
    case 'halftone': return halftone(img, f.cell, f.angle);
    case 'clouds': return clouds(img, f, seed);
    case 'emboss': return emboss(img, f.angle, f.strength);
    case 'find_edges': return edges(img, f.strength);
  }
}

// ---------------------------------------------------------------- blur family

function toPremul(img: Img): Float32Array[] {
  const n = img.width * img.height, d = img.data;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    ch[0][i] = d[i * 4] * a; ch[1][i] = d[i * 4 + 1] * a; ch[2][i] = d[i * 4 + 2] * a; ch[3][i] = d[i * 4 + 3];
  }
  return ch;
}

function fromPremul(img: Img, ch: Float32Array[]) {
  const n = img.width * img.height, d = img.data;
  for (let i = 0; i < n; i++) {
    const A = ch[3][i], a = A / 255;
    d[i * 4 + 3] = clamp255(A);
    if (a > 0.0001) { d[i * 4] = clamp255(ch[0][i] / a); d[i * 4 + 1] = clamp255(ch[1][i] / a); d[i * 4 + 2] = clamp255(ch[2][i] / a); }
  }
}

function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const stride = horizontal ? 1 : w, lineStride = horizontal ? w : 1;
  const norm = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * stride];
    for (let i = 0; i < len; i++) {
      dst[base + i * stride] = sum * norm;
      const add = Math.min(len - 1, i + r + 1), rem = Math.max(0, i - r);
      sum += src[base + add * stride] - src[base + rem * stride];
    }
  }
}

function blurChannels(ch: Float32Array[], w: number, h: number, radius: number) {
  if (radius < 0.5) return;
  // three box passes approximate a gaussian with sigma ≈ radius/2
  const sigma = radius / 2;
  const boxes = boxesForGauss(sigma, 3);
  const tmp = new Float32Array(w * h);
  for (const c of ch) for (const b of boxes) {
    const r = Math.max(0, Math.round((b - 1) / 2));
    if (!r) continue;
    boxPass(c, tmp, w, h, r, true);
    boxPass(tmp, c, w, h, r, false);
  }
}

function boxesForGauss(sigma: number, n: number) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

function blur(img: Img, radius: number) {
  const ch = toPremul(img);
  blurChannels(ch, img.width, img.height, radius);
  fromPremul(img, ch);
}

function motionBlur(img: Img, distance: number, angleDeg: number) {
  const { width: w, height: h } = img;
  const ch = toPremul(img);
  const out = ch.map(() => new Float32Array(w * h));
  const a = (angleDeg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
  const n = Math.max(2, Math.round(distance));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1) - 0.5;
      const sx = Math.min(w - 1, Math.max(0, Math.round(x + dx * t * distance)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(y + dy * t * distance)));
      const j = sy * w + sx;
      s0 += ch[0][j]; s1 += ch[1][j]; s2 += ch[2][j]; s3 += ch[3][j];
    }
    const i = y * w + x;
    out[0][i] = s0 / n; out[1][i] = s1 / n; out[2][i] = s2 / n; out[3][i] = s3 / n;
  }
  fromPremul(img, out);
}

function unsharp(img: Img, radius: number, amount: number) {
  const orig = new Uint8ClampedArray(img.data);
  blur(img, radius);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) d[i + c] = clamp255(orig[i + c] + (orig[i + c] - d[i + c]) * amount);
    d[i + 3] = orig[i + 3];
  }
}

function glow(img: Img, radius: number, intensity: number) {
  const orig = new Uint8ClampedArray(img.data);
  const ch = toPremul(img);
  blurChannels(ch, img.width, img.height, radius);
  const d = img.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const oa = orig[i + 3] / 255;
    // screen the blurred light over the original (premultiplied)
    const ga = Math.min(1, (ch[3][p] / 255) * intensity);
    const outA = oa + ga - oa * ga;
    for (let c = 0; c < 3; c++) {
      const o = (orig[i + c] / 255) * oa, g = Math.min(1, (ch[c][p] / 255) * intensity);
      const v = o + g - o * g;
      d[i + c] = outA > 0 ? clamp255((v / outA) * 255) : 0;
    }
    d[i + 3] = clamp255(outA * 255);
  }
}

// ---------------------------------------------------------------- pixel & displacement

function noise(img: Img, amount: number, mono: boolean, seed: number) {
  const rng = mulberry32(seed), d = img.data, amp = amount * 255;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    if (mono) { const n = (rng() - 0.5) * amp; d[i] = clamp255(d[i] + n); d[i + 1] = clamp255(d[i + 1] + n); d[i + 2] = clamp255(d[i + 2] + n); }
    else for (let c = 0; c < 3; c++) d[i + c] = clamp255(d[i + c] + (rng() - 0.5) * amp);
  }
}

function pixelate(img: Img, cell: number) {
  const { width: w, height: h, data: d } = img;
  cell = Math.max(2, Math.round(cell));
  for (let by = 0; by < h; by += cell) for (let bx = 0; bx < w; bx += cell) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let y = by; y < Math.min(h, by + cell); y++) for (let x = bx; x < Math.min(w, bx + cell); x++) {
      const i = (y * w + x) * 4, al = d[i + 3];
      r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al; n++;
    }
    const A = a / n;
    for (let y = by; y < Math.min(h, by + cell); y++) for (let x = bx; x < Math.min(w, bx + cell); x++) {
      const i = (y * w + x) * 4;
      if (a > 0) { d[i] = r / a; d[i + 1] = g / a; d[i + 2] = b / a; }
      d[i + 3] = A;
    }
  }
}

function displace(img: Img, map: (x: number, y: number) => [number, number]) {
  const { width: w, height: h } = img;
  const src = new Uint8ClampedArray(img.data), d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [sx, sy] = map(x + 0.5, y + 0.5);
    bilinear(src, w, h, sx - 0.5, sy - 0.5, d, (y * w + x) * 4);
  }
}

function bilinear(src: Uint8ClampedArray, w: number, h: number, x: number, y: number, out: Uint8ClampedArray, o: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let r = 0, g = 0, b = 0, a = 0;
  for (let k = 0; k < 4; k++) {
    const xx = x0 + (k & 1), yy = y0 + (k >> 1);
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const wgt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
    const i = (yy * w + xx) * 4, al = src[i + 3] * wgt;
    r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al;
  }
  out[o + 3] = a;
  if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
}

function halftone(img: Img, cell: number, angleDeg: number) {
  const { width: w, height: h } = img;
  const src = new Uint8ClampedArray(img.data), d = img.data;
  cell = Math.max(3, cell);
  const a = (angleDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (!src[i + 3]) continue;
    // rotate into screen space, find the dot center of this cell
    const u = x * ca + y * sa, v = -x * sa + y * ca;
    const cu = (Math.floor(u / cell) + 0.5) * cell, cv = (Math.floor(v / cell) + 0.5) * cell;
    const cx = cu * ca - cv * sa, cy = cu * sa + cv * ca;
    const sx = Math.min(w - 1, Math.max(0, Math.round(cx))), sy = Math.min(h - 1, Math.max(0, Math.round(cy)));
    const j = (sy * w + sx) * 4;
    const lum = (0.299 * src[j] + 0.587 * src[j + 1] + 0.114 * src[j + 2]) / 255;
    const rad = Math.sqrt(1 - lum) * cell * 0.72;
    const dist = Math.hypot(u - cu, v - cv);
    const ink = Math.max(0, Math.min(1, rad - dist + 0.5));
    const vval = 255 * (1 - ink);
    d[i] = d[i + 1] = d[i + 2] = vval;
  }
}

function clouds(img: Img, f: Extract<FilterSpec, { kind: 'clouds' }>, seed: number) {
  const { width: w, height: h, data: d } = img;
  const { fbm } = makeNoise2D(seed);
  const sc = Math.max(8, f.scale), oct = Math.max(1, Math.min(8, Math.round(f.detail)));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = Math.min(1, Math.max(0, (fbm(x / sc, y / sc, oct) - 0.5) * 1.8 + 0.5));
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) d[i + c] = f.color_a[c] + (f.color_b[c] - f.color_a[c]) * t;
    d[i + 3] = 255 * (f.color_a[3] + (f.color_b[3] - f.color_a[3]) * t);
  }
}

function emboss(img: Img, angleDeg: number, strength: number) {
  const { width: w, height: h } = img;
  const src = new Uint8ClampedArray(img.data), d = img.data;
  const a = (angleDeg * Math.PI) / 180, ox = Math.round(Math.cos(a) * 1.5), oy = Math.round(Math.sin(a) * 1.5);
  const lum = (i: number) => 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const x1 = Math.min(w - 1, Math.max(0, x - ox)), y1 = Math.min(h - 1, Math.max(0, y - oy));
    const x2 = Math.min(w - 1, Math.max(0, x + ox)), y2 = Math.min(h - 1, Math.max(0, y + oy));
    const v = clamp255(128 + (lum((y2 * w + x2) * 4) - lum((y1 * w + x1) * 4)) * strength);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
}

function edges(img: Img, strength: number) {
  const { width: w, height: h } = img;
  const src = new Uint8ClampedArray(img.data), d = img.data;
  const at = (x: number, y: number, c: number) => src[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      const gx = -at(x - 1, y - 1, c) - 2 * at(x - 1, y, c) - at(x - 1, y + 1, c) + at(x + 1, y - 1, c) + 2 * at(x + 1, y, c) + at(x + 1, y + 1, c);
      const gy = -at(x - 1, y - 1, c) - 2 * at(x, y - 1, c) - at(x + 1, y - 1, c) + at(x - 1, y + 1, c) + 2 * at(x, y + 1, c) + at(x + 1, y + 1, c);
      d[i + c] = clamp255(255 - Math.hypot(gx, gy) * strength * 0.25);
    }
  }
}
