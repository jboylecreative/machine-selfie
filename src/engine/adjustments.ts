// Adjustment layers: non-destructive color operations applied to everything beneath them.

import type { Adjustment } from './ops.ts';
import { hslToRgb, rgbToHsl } from './color.ts';

type Img = { data: Uint8ClampedArray; width: number; height: number };
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Monotone cubic interpolation through curve points ([[in,out],...] in 0..255) → 256-entry LUT. */
export function curveLut(points: number[][] | undefined): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const pts = (points?.length ? points : [[0, 0], [255, 255]]).map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0]);
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
  if (pts[pts.length - 1][0] < 255) pts.push([255, pts[pts.length - 1][1]]);
  const n = pts.length;
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx.push(Math.max(1e-6, pts[i + 1][0] - pts[i][0])); dy.push(pts[i + 1][1] - pts[i][1]); m.push(dy[i] / dx[i]); }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    while (seg < n - 2 && x > pts[seg + 1][0]) seg++;
    const h = dx[seg], u = Math.min(1, Math.max(0, (x - pts[seg][0]) / h));
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
    lut[x] = clamp255(h00 * pts[seg][1] + h10 * h * t[seg] + h01 * pts[seg + 1][1] + h11 * h * t[seg + 1]);
  }
  return lut;
}

function lutFromFn(fn: (v: number) => number) {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = clamp255(fn(i));
  return lut;
}

export function applyAdjustment(img: Img, adj: Adjustment): void {
  const d = img.data;
  const luts = (r: Uint8ClampedArray, g = r, b = r) => {
    for (let i = 0; i < d.length; i += 4) { d[i] = r[d[i]]; d[i + 1] = g[d[i + 1]]; d[i + 2] = b[d[i + 2]]; }
  };
  switch (adj.kind) {
    case 'curves': {
      const all = curveLut(adj.rgb);
      const r = curveLut(adj.r), g = curveLut(adj.g), b = curveLut(adj.b);
      const comp = (ch: Uint8ClampedArray) => lutFromFn((v) => ch[all[v]]);
      return luts(comp(r), comp(g), comp(b));
    }
    case 'levels': {
      const { in_black: ib, in_white: iw, gamma, out_black: ob, out_white: ow } = adj;
      return luts(lutFromFn((v) => {
        const t = Math.min(1, Math.max(0, (v - ib) / Math.max(1, iw - ib)));
        return ob + (ow - ob) * Math.pow(t, 1 / Math.max(0.01, gamma));
      }));
    }
    case 'brightness_contrast': {
      const c = Math.max(-100, Math.min(100, adj.contrast)) / 100;
      const k = c >= 0 ? 1 / Math.max(0.01, 1 - c) : 1 + c;
      return luts(lutFromFn((v) => (v + adj.brightness * 1.5 - 128) * k + 128));
    }
    case 'posterize': {
      const n = Math.max(2, Math.round(adj.levels));
      return luts(lutFromFn((v) => Math.round((v / 255) * (n - 1)) * (255 / (n - 1))));
    }
    case 'invert': return luts(lutFromFn((v) => 255 - v));
    case 'threshold': {
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i] = d[i + 1] = d[i + 2] = l >= adj.level ? 255 : 0;
      }
      return;
    }
    case 'black_white': {
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      return;
    }
    case 'hue_saturation': {
      const ds = adj.saturation / 100, dl = adj.lightness / 100;
      for (let i = 0; i < d.length; i += 4) {
        let [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
        if (adj.colorize) { h = adj.hue; s = Math.max(0, Math.min(1, 0.25 + ds * 0.75)); }
        else { h += adj.hue; s = ds >= 0 ? s + (1 - s) * ds * s : s * (1 + ds); }
        l = dl >= 0 ? l + (1 - l) * dl : l * (1 + dl);
        const [r, g, b] = hslToRgb(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)));
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
      return;
    }
    case 'vibrance': {
      const amt = adj.amount / 100;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const max = Math.max(r, g, b), avg = (r + g + b) / 3;
        const k = amt * (1 - (max - Math.min(r, g, b)) / 255) * 1.5;
        d[i] = clamp255(r + (r - avg) * k); d[i + 1] = clamp255(g + (g - avg) * k); d[i + 2] = clamp255(b + (b - avg) * k);
      }
      return;
    }
    case 'color_balance': {
      const sh = adj.shadows, mid = adj.midtones, hi = adj.highlights;
      for (let i = 0; i < d.length; i += 4) {
        const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
        const ws = Math.max(0, 1 - l * 3), wh = Math.max(0, l * 3 - 2), wm = 1 - Math.abs(l - 0.5) * 2;
        for (let c = 0; c < 3; c++) d[i + c] = clamp255(d[i + c] + ((sh[c] ?? 0) * ws + (mid[c] ?? 0) * wm + (hi[c] ?? 0) * wh) * 1.28);
      }
      return;
    }
    case 'photo_filter': {
      const k = Math.max(0, Math.min(1, adj.density));
      for (let i = 0; i < d.length; i += 4) {
        // multiply by the filter color, then restore the original luminosity
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const f = [0, 1, 2].map((c) => (d[i + c] * adj.color[c]) / 255);
        const fl = 0.299 * f[0] + 0.587 * f[1] + 0.114 * f[2];
        const scale = fl > 0.5 ? l / fl : 1;
        for (let c = 0; c < 3; c++) d[i + c] = clamp255(d[i + c] + (f[c] * scale - d[i + c]) * k);
      }
      return;
    }
    case 'gradient_map': {
      const stops = [...adj.stops].sort((a, b) => a.offset - b.offset);
      const lut = new Array(256).fill(0).map((_, v) => {
        const t = v / 255;
        let j = 0;
        while (j < stops.length - 1 && stops[j + 1].offset < t) j++;
        const a = stops[j], b = stops[Math.min(stops.length - 1, j + 1)];
        const u = b.offset > a.offset ? Math.min(1, Math.max(0, (t - a.offset) / (b.offset - a.offset))) : 0;
        return [0, 1, 2].map((c) => a.color[c] + (b.color[c] - a.color[c]) * u);
      });
      for (let i = 0; i < d.length; i += 4) {
        const l = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        const c = lut[l]; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
      }
      return;
    }
  }
}
