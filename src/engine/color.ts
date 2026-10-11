// Color parsing/formatting. Ops always carry normalized RGBA tuples so the server and
// every viewer interpret colors identically.

export type RGBA = [r: number, g: number, b: number, a: number]; // r,g,b 0-255, a 0-1

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', gray: '#808080', grey: '#808080',
  orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a', transparent: '#00000000',
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function parseColor(input: unknown): RGBA {
  if (Array.isArray(input) && input.length >= 3) {
    const [r, g, b, a = 1] = input.map(Number);
    if ([r, g, b, a].some((v) => !Number.isFinite(v))) throw new Error(`bad color ${JSON.stringify(input)}`);
    return [clamp(Math.round(r), 0, 255), clamp(Math.round(g), 0, 255), clamp(Math.round(b), 0, 255), clamp(a, 0, 1)];
  }
  if (typeof input !== 'string') throw new Error(`bad color ${JSON.stringify(input)}`);
  let s = input.trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];

  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) throw new Error(`bad hex color "${input}"`);
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
  }

  const m = s.match(/^(rgba?|hsla?)\(([^)]*)\)$/);
  if (m) {
    const parts = m[2].split(/[\s,/]+/).filter(Boolean);
    const num = (p: string, scale: number) => (p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p));
    if (m[1].startsWith('rgb')) {
      const [r, g, b] = parts.slice(0, 3).map((p) => num(p, 255));
      const a = parts[3] !== undefined ? num(parts[3], 1) : 1;
      return parseColor([r, g, b, a]);
    }
    const h = parseFloat(parts[0]);
    const sat = num(parts[1] ?? '0', 1) * (parts[1]?.endsWith('%') ? 1 : 0.01);
    const lig = num(parts[2] ?? '0', 1) * (parts[2]?.endsWith('%') ? 1 : 0.01);
    const a = parts[3] !== undefined ? num(parts[3], 1) : 1;
    const [r, g, b] = hslToRgb(h, sat, lig);
    return parseColor([r, g, b, a]);
  }
  throw new Error(`unrecognized color "${input}" (use hex like #1a2b3c, rgb(), rgba(), hsl() or hsla())`);
}

export function css(c: RGBA, alphaMul = 1): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${+(c[3] * alphaMul).toFixed(4)})`;
}

export function toHex(c: RGBA): string {
  const h = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}${c[3] < 1 ? h(c[3] * 255) : ''}`;
}

/** h in degrees, s/l in 0..1 → r,g,b 0..255 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** r,g,b 0..255 → [h deg, s 0..1, l 0..1] */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
