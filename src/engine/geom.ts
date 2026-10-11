// Geometry: SVG path parsing/flattening, smooth curves through points, arc-length utilities.
// Everything the artist draws is reduced to polylines so it can be revealed progressively.

export type Pt = [number, number];
export interface Polyline { pts: Pt[]; closed: boolean }

const TOL = 0.35; // flattening tolerance in px

// ---------------------------------------------------------------- SVG path parsing

export function parseSvgPath(d: string): Polyline[] {
  if (typeof d !== 'string' || !d.trim()) throw new Error('path data is empty');
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
  if (!tokens) throw new Error('could not parse path data');
  const out: Polyline[] = [];
  let cur: Pt[] = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastCtrl: Pt | null = null; let lastCmd = '';
  let i = 0;
  let cmd = '';
  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t);
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || isCmd(t)) throw new Error(`path data: expected number after "${cmd}"`);
    return parseFloat(t);
  };
  const flush = (closed: boolean) => {
    if (cur.length > 1) out.push({ pts: cur, closed });
    cur = [];
  };
  const lineTo = (nx: number, ny: number) => { if (!cur.length) cur.push([x, y]); cur.push([nx, ny]); x = nx; y = ny; };

  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    else if (!cmd) throw new Error('path data must start with a command (M)');
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case 'M': { flush(false); x = ox + num(); y = oy + num(); sx = x; sy = y; cur.push([x, y]); lastCtrl = null; break; }
      case 'L': { const nx = ox + num(), ny = oy + num(); lineTo(nx, ny); lastCtrl = null; break; }
      case 'H': { lineTo(ox + num(), y); lastCtrl = null; break; }
      case 'V': { lineTo(x, oy + num()); lastCtrl = null; break; }
      case 'C': case 'S': {
        let c1: Pt;
        if (C === 'C') c1 = [ox + num(), oy + num()];
        else c1 = lastCtrl && /[CS]/i.test(lastCmd) ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
        const c2: Pt = [ox + num(), oy + num()];
        const p: Pt = [ox + num(), oy + num()];
        if (!cur.length) cur.push([x, y]);
        cubic(cur, [x, y], c1, c2, p);
        lastCtrl = c2; x = p[0]; y = p[1];
        break;
      }
      case 'Q': case 'T': {
        let c: Pt;
        if (C === 'Q') c = [ox + num(), oy + num()];
        else c = lastCtrl && /[QT]/i.test(lastCmd) ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
        const p: Pt = [ox + num(), oy + num()];
        if (!cur.length) cur.push([x, y]);
        const c1: Pt = [x + (2 / 3) * (c[0] - x), y + (2 / 3) * (c[1] - y)];
        const c2: Pt = [p[0] + (2 / 3) * (c[0] - p[0]), p[1] + (2 / 3) * (c[1] - p[1])];
        cubic(cur, [x, y], c1, c2, p);
        lastCtrl = c; x = p[0]; y = p[1];
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const p: Pt = [ox + num(), oy + num()];
        if (!cur.length) cur.push([x, y]);
        arc(cur, [x, y], rx, ry, rot, !!large, !!sweep, p);
        x = p[0]; y = p[1]; lastCtrl = null;
        break;
      }
      case 'Z': {
        if (cur.length) { if (x !== sx || y !== sy) cur.push([sx, sy]); flush(true); }
        x = sx; y = sy; lastCtrl = null;
        cur = [];
        break;
      }
      default: throw new Error(`unsupported path command "${cmd}"`);
    }
    lastCmd = cmd;
    if (C === 'Z' && i < tokens.length && !isCmd(tokens[i])) throw new Error('path data: numbers after Z');
  }
  flush(false);
  if (!out.length) throw new Error('path data produced no segments');
  return out;
}

function cubic(out: Pt[], p0: Pt, p1: Pt, p2: Pt, p3: Pt) {
  const len = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
  const n = Math.max(2, Math.min(400, Math.ceil(Math.sqrt(len / TOL) * 1.2)));
  for (let k = 1; k <= n; k++) {
    const t = k / n, mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
}

function arc(out: Pt[], p0: Pt, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, p: Pt) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) { out.push(p); return; }
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p[0]) / 2, dy = (p0[1] - p[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / 3));
  for (let k = 1; k <= n; k++) {
    const t = t1 + (dt * k) / n;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
}

// ---------------------------------------------------------------- smooth curves through points

/** Centripetal Catmull-Rom spline through points, densely sampled. Extra fields (pressure) are interpolated. */
export function smoothThrough(points: number[][], step = 1.5): number[][] {
  if (points.length < 3) return densify(points, step);
  const out: number[][] = [points[0]];
  const P = [points[0], ...points, points[points.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(1, Math.ceil(segLen / step));
    const t0 = 0;
    const t1 = t0 + Math.pow(Math.max(1e-4, Math.hypot(p1[0] - p0[0], p1[1] - p0[1])), 0.5);
    const t2 = t1 + Math.pow(Math.max(1e-4, segLen), 0.5);
    const t3 = t2 + Math.pow(Math.max(1e-4, Math.hypot(p3[0] - p2[0], p3[1] - p2[1])), 0.5);
    for (let k = 1; k <= n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const dims = p1.length;
      const pt: number[] = [];
      for (let d = 0; d < dims; d++) {
        if (d >= 2) { pt.push(p1[d] + ((p2[d] - p1[d]) * k) / n); continue; } // linear for pressure
        const A1 = ((t1 - t) / (t1 - t0)) * p0[d] + ((t - t0) / (t1 - t0)) * p1[d];
        const A2 = ((t2 - t) / (t2 - t1)) * p1[d] + ((t - t1) / (t2 - t1)) * p2[d];
        const A3 = ((t3 - t) / (t3 - t2)) * p2[d] + ((t - t2) / (t3 - t2)) * p3[d];
        const B1 = ((t2 - t) / (t2 - t0)) * A1 + ((t - t0) / (t2 - t0)) * A2;
        const B2 = ((t3 - t) / (t3 - t1)) * A2 + ((t - t1) / (t3 - t1)) * A3;
        pt.push(((t2 - t) / (t2 - t1)) * B1 + ((t - t1) / (t2 - t1)) * B2);
      }
      out.push(pt);
    }
  }
  return out;
}

export function densify(points: number[][], step = 1.5): number[][] {
  if (points.length < 2) return points.slice();
  const out: number[][] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push(a.map((v, d) => v + ((b[d] - v) * k) / n));
  }
  return out;
}

// ---------------------------------------------------------------- arc length

export const dist = (a: Pt | number[], b: Pt | number[]) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function polylineLength(pts: (Pt | number[])[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

export function totalLength(lines: Polyline[]): number {
  return lines.reduce((s, l) => s + polylineLength(l.pts), 0);
}

/** The first `len` px of a set of polylines (later subpaths only appear once earlier ones are complete). */
export function prefix(lines: Polyline[], len: number): Polyline[] {
  const out: Polyline[] = [];
  let left = len;
  for (const l of lines) {
    if (left <= 0) break;
    const L = polylineLength(l.pts);
    if (L <= left) { out.push(l); left -= L; continue; }
    const pts: Pt[] = [l.pts[0]];
    for (let i = 1; i < l.pts.length; i++) {
      const d = dist(l.pts[i - 1], l.pts[i]);
      if (d >= left) {
        const t = d ? left / d : 0;
        pts.push([l.pts[i - 1][0] + (l.pts[i][0] - l.pts[i - 1][0]) * t, l.pts[i - 1][1] + (l.pts[i][1] - l.pts[i - 1][1]) * t]);
        break;
      }
      pts.push(l.pts[i]);
      left -= d;
    }
    out.push({ pts, closed: false });
    break;
  }
  return out;
}

export function bounds(lines: Polyline[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) for (const [x, y] of l.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

export function tracePolylines(ctx: CanvasRenderingContext2D, lines: Polyline[]) {
  ctx.beginPath();
  for (const l of lines) {
    if (!l.pts.length) continue;
    ctx.moveTo(l.pts[0][0], l.pts[0][1]);
    for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i][0], l.pts[i][1]);
    if (l.closed) ctx.closePath();
  }
}
