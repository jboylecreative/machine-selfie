// The layered document and its compositor, plus "runners": every op can be played out
// progressively (viewers watch the line being drawn) or completed instantly (server).

import type { Adjustment, BlendMode, FilterOp, FillOp, FloodOp, Gradient, LayerProps, Op, Paint, PathOp, ShapeStroke, SmudgeOp, StrokeOp, TextOp, TransformOp } from './ops.ts';
import { css, toHex, type RGBA } from './color.ts';
import { computeSteps, drawDab, TipCache, type Step } from './brushes.ts';
import { applyFilter } from './filters.ts';
import { applyAdjustment } from './adjustments.ts';
import { bounds, parseSvgPath, prefix, smoothThrough, totalLength, tracePolylines, type Polyline } from './geom.ts';
import { clampRect, cloneCanvas, ctx2d, src, type Canvas, type Platform, type Rect } from './surface.ts';

export interface Layer {
  id: string;
  name: string;
  kind: 'paint' | 'adjustment';
  canvas: Canvas | null;
  adjustment: Adjustment | null;
  opacity: number;
  blend: BlendMode;
  visible: boolean;
  alphaLock: boolean;
  clip: boolean;
  version: number;
  live: (() => Canvas) | null; // preview override while an op is being animated
}

export interface Runner {
  readonly label: string;
  readonly layerId: string | null;
  readonly units: number;
  readonly durationMs: number;
  advance(units: number): void;
  finish(): void;
  /** where the "pen" is, for viewer overlays */
  cursor(): { x: number; y: number; r: number } | null;
  /** construction lines shown to viewers but not part of the artwork */
  guide(): Polyline[] | null;
}

export const blendOp = (b: BlendMode): GlobalCompositeOperation =>
  (b === 'normal' ? 'source-over' : b === 'add' ? 'lighter' : b) as GlobalCompositeOperation;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class StudioDocument {
  width = 1200;
  height = 1200;
  layers: Layer[] = [];
  marks = 0; // number of content-changing ops so far
  version = 0;
  readonly tips: TipCache;

  private composite!: Canvas;
  private compositeVersion = -1;
  private pool = new Map<string, Canvas>();
  private below: { key: string; canvas: Canvas } | null = null;

  constructor(readonly platform: Platform) {
    this.tips = new TipCache(platform);
    this.reset(1200, 1200, [255, 255, 255, 1]);
  }

  // ------------------------------------------------------------------ basics

  reset(width: number, height: number, background: RGBA | null) {
    this.width = width; this.height = height;
    this.layers = [];
    this.pool.clear();
    this.below = null;
    this.composite = this.platform.createCanvas(width, height);
    if (background) {
      const l = this.addPaintLayer('bg', 'Background', 0);
      const ctx = ctx2d(l.canvas!);
      ctx.fillStyle = css(background);
      ctx.fillRect(0, 0, width, height);
    }
    this.touch();
  }

  /** Scratch canvases, full document size, reused across operations. */
  scratch(name: string): Canvas {
    let c = this.pool.get(name);
    if (!c || c.width !== this.width || c.height !== this.height) {
      c = this.platform.createCanvas(this.width, this.height);
      this.pool.set(name, c);
    }
    return c;
  }

  touch(layer?: Layer) {
    if (layer) layer.version++;
    this.version++;
  }

  layer(id: string): Layer {
    const l = this.layers.find((x) => x.id === id);
    if (!l) throw new Error(`no layer with id "${id}"`);
    return l;
  }

  paintLayer(id: string): Layer {
    const l = this.layer(id);
    if (l.kind !== 'paint') throw new Error(`layer "${l.name}" (${id}) is an adjustment layer and holds no pixels`);
    return l;
  }

  addPaintLayer(id: string, name: string, index: number): Layer {
    const l: Layer = {
      id, name, kind: 'paint', canvas: this.platform.createCanvas(this.width, this.height), adjustment: null,
      opacity: 1, blend: 'normal', visible: true, alphaLock: false, clip: false, version: 0, live: null,
    };
    this.layers.splice(clamp(index, 0, this.layers.length), 0, l);
    return l;
  }

  // ------------------------------------------------------------------ compositing

  private layerSource(l: Layer): Canvas { return l.live ? l.live() : l.canvas!; }

  private signature(upto: number) {
    let s = `${this.width}x${this.height}|`;
    for (let i = 0; i < upto; i++) s += `${this.layers[i].id}:${this.layers[i].version};`;
    return s;
  }

  render(): Canvas {
    if (this.compositeVersion === this.version && !this.layers.some((l) => l.live)) return this.composite;
    const ctx = ctx2d(this.composite);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.width, this.height);

    // layers below the one being animated rarely change: cache them
    let start = 0;
    let liveIdx = this.layers.findIndex((l) => l.live);
    if (liveIdx > 0) {
      while (liveIdx > 0 && this.layers[liveIdx].clip) liveIdx--;
      if (liveIdx > 0) {
        const key = this.signature(liveIdx);
        if (!this.below || this.below.key !== key) {
          const c = this.below?.canvas ?? this.platform.createCanvas(this.width, this.height);
          if (c.width !== this.width || c.height !== this.height) { c.width = this.width; c.height = this.height; }
          const bctx = ctx2d(c);
          bctx.clearRect(0, 0, this.width, this.height);
          this.compositeRange(bctx, 0, liveIdx);
          this.below = { key, canvas: c };
        }
        ctx.drawImage(src(this.below.canvas), 0, 0);
        start = liveIdx;
      }
    }
    this.compositeRange(ctx, start, this.layers.length);
    this.compositeVersion = this.version;
    return this.composite;
  }

  private compositeRange(ctx: CanvasRenderingContext2D, from: number, to: number) {
    let i = from;
    while (i < to) {
      const base = this.layers[i];
      let j = i + 1;
      while (j < to && this.layers[j].clip) j++;
      if (!base.visible) { i = j; continue; }
      if (base.kind === 'adjustment') {
        this.applyAdjustmentLayer(ctx, base);
        i = j; // clipping to an adjustment layer is meaningless; ignore its clip group
        continue;
      }
      if (j === i + 1) {
        this.drawLayer(ctx, this.layerSource(base), base.opacity, base.blend);
      } else {
        const group = this.scratch('group');
        const g = ctx2d(group);
        g.globalAlpha = 1; g.globalCompositeOperation = 'copy';
        const baseSrc = this.layerSource(base);
        g.drawImage(src(baseSrc), 0, 0);
        g.globalCompositeOperation = 'source-over';
        for (let k = i + 1; k < j; k++) {
          const c = this.layers[k];
          if (!c.visible) continue;
          if (c.kind === 'adjustment') this.applyAdjustmentLayer(g, c);
          else this.drawLayer(g, this.layerSource(c), c.opacity, c.blend);
        }
        g.globalAlpha = 1; g.globalCompositeOperation = 'destination-in';
        g.drawImage(src(baseSrc), 0, 0);
        g.globalCompositeOperation = 'source-over';
        this.drawLayer(ctx, group, base.opacity, base.blend);
      }
      i = j;
    }
  }

  private drawLayer(ctx: CanvasRenderingContext2D, c: Canvas, opacity: number, blend: BlendMode) {
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = blendOp(blend);
    ctx.drawImage(src(c), 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private applyAdjustmentLayer(ctx: CanvasRenderingContext2D, l: Layer) {
    if (!l.adjustment) return;
    const img = ctx.getImageData(0, 0, this.width, this.height);
    applyAdjustment(img, l.adjustment);
    const tmp = this.scratch('adjust');
    ctx2d(tmp).putImageData(img, 0, 0);
    this.drawLayer(ctx, tmp, l.opacity, l.blend);
  }

  /** Flattened artwork over a paper color (what the artist "sees"). */
  flatten(paper = '#ffffff', maxSide = Infinity, region?: Rect): Canvas {
    const comp = this.render();
    const r = region ?? { x: 0, y: 0, w: this.width, h: this.height };
    const scale = Math.min(1, maxSide / Math.max(r.w, r.h)) || 1;
    const zoom = region ? Math.min(maxSide / Math.max(r.w, r.h), 8) : scale;
    const out = this.platform.createCanvas(Math.max(1, Math.round(r.w * zoom)), Math.max(1, Math.round(r.h * zoom)));
    const ctx = ctx2d(out);
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingEnabled = zoom < 3; // close zooms show crisp pixels
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src(comp), r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
    return out;
  }

  sampleColor(x: number, y: number): string {
    const ctx = ctx2d(this.render());
    const d = ctx.getImageData(clamp(Math.round(x), 0, this.width - 1), clamp(Math.round(y), 0, this.height - 1), 1, 1).data;
    return toHex([d[0], d[1], d[2], d[3] / 255]);
  }

  /** Bounding box of non-transparent pixels in a layer (null if empty). */
  contentBounds(id: string): Rect | null {
    const l = this.layer(id);
    if (!l.canvas) return null;
    const { data } = ctx2d(l.canvas).getImageData(0, 0, this.width, this.height);
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      if (data[(y * this.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // ------------------------------------------------------------------ ops

  apply(op: Op): void {
    const r = this.run(op, false);
    r.finish();
  }

  run(op: Op, preview = true): Runner {
    switch (op.t) {
      case 'canvas': return instant('new canvas', null, () => { this.reset(op.width, op.height, op.background); this.marks = 0; });
      case 'layer.new': return instant(`new layer "${op.name}"`, op.id, () => {
        if (op.adjustment) {
          const l: Layer = { id: op.id, name: op.name, kind: 'adjustment', canvas: null, adjustment: op.adjustment, opacity: op.opacity, blend: op.blend, visible: true, alphaLock: false, clip: false, version: 0, live: null };
          this.layers.splice(clamp(op.index, 0, this.layers.length), 0, l);
        } else {
          const l = this.addPaintLayer(op.id, op.name, op.index);
          l.opacity = op.opacity; l.blend = op.blend;
        }
        this.touch();
      });
      case 'layer.set': return instant(`layer settings`, op.id, () => this.setProps(op.id, op.props));
      case 'layer.move': return instant(`reorder layer`, op.id, () => {
        const l = this.layer(op.id);
        this.layers.splice(this.layers.indexOf(l), 1);
        this.layers.splice(clamp(op.index, 0, this.layers.length), 0, l);
        this.touch(l);
      });
      case 'layer.delete': return instant(`delete layer`, op.id, () => {
        const l = this.layer(op.id);
        this.layers.splice(this.layers.indexOf(l), 1);
        this.touch();
      });
      case 'layer.duplicate': return instant(`duplicate layer`, op.newId, () => {
        const l = this.layer(op.id);
        const copy: Layer = { ...l, id: op.newId, name: op.name, version: 0, live: null, canvas: l.canvas ? cloneCanvas(this.platform, l.canvas) : null, adjustment: l.adjustment ? structuredClone(l.adjustment) : null };
        this.layers.splice(this.layers.indexOf(l) + 1, 0, copy);
        this.touch();
      });
      case 'layer.merge': return instant(`merge down`, op.id, () => {
        const upper = this.layer(op.id);
        const idx = this.layers.indexOf(upper);
        const lower = this.layers[idx - 1];
        if (!lower || lower.kind !== 'paint' || upper.kind !== 'paint') throw new Error('merge_down needs two pixel layers');
        const ctx = ctx2d(lower.canvas!);
        if (upper.visible) this.drawLayer(ctx, upper.canvas!, upper.opacity, upper.blend);
        this.layers.splice(idx, 1);
        this.marks++;
        this.touch(lower);
      });
      case 'layer.clear': return this.fadeRunner('clear layer', op.id, preview, (l) => {
        ctx2d(l.canvas!).clearRect(0, 0, this.width, this.height);
      });
      case 'stroke': return this.strokeRunner(op, preview);
      case 'smudge': return this.smudgeRunner(op);
      case 'path': return this.pathRunner(op);
      case 'fill': return this.fillRunner(op);
      case 'flood': return this.floodRunner(op, preview);
      case 'text': return this.textRunner(op);
      case 'filter': return this.filterRunner(op, preview);
      case 'transform': return this.transformRunner(op);
    }
  }

  private setProps(id: string, p: LayerProps) {
    const l = this.layer(id);
    if (p.name !== undefined) l.name = p.name;
    if (p.opacity !== undefined) l.opacity = clamp(p.opacity, 0, 1);
    if (p.blend !== undefined) l.blend = p.blend;
    if (p.visible !== undefined) l.visible = p.visible;
    if (p.alphaLock !== undefined) l.alphaLock = p.alphaLock;
    if (p.clip !== undefined) l.clip = p.clip;
    if (p.adjustment !== undefined && l.kind === 'adjustment') l.adjustment = p.adjustment;
    this.touch(l);
  }

  // ------------------------------------------------------------------ buffered painting
  // Paint ops render into a "wet" buffer that is composited onto the layer on completion.
  // Viewers see the layer + buffer composited every frame, so preview == final result.

  private composeBuffer(
    target: Canvas, buffer: Canvas, bbox: Rect,
    o: { alpha: number; blend: BlendMode; erase?: boolean; alphaLock: boolean; grain?: number; selection?: Polyline[] | null },
  ) {
    let source = buffer;
    if (o.grain && o.grain > 0) {
      const g = this.scratch('grain');
      const gctx = ctx2d(g);
      gctx.globalCompositeOperation = 'copy';
      gctx.drawImage(src(buffer), bbox.x, bbox.y, bbox.w, bbox.h, bbox.x, bbox.y, bbox.w, bbox.h);
      gctx.globalCompositeOperation = 'destination-in';
      gctx.fillStyle = this.tips.grain(o.grain, gctx);
      gctx.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);
      gctx.globalCompositeOperation = 'source-over';
      source = g;
    }
    const ctx = ctx2d(target);
    let saved: Canvas | null = null;
    if (o.alphaLock && !o.erase) {
      saved = this.scratch('alphalock');
      const s = ctx2d(saved);
      s.globalCompositeOperation = 'copy';
      s.drawImage(src(target), bbox.x, bbox.y, bbox.w, bbox.h, bbox.x, bbox.y, bbox.w, bbox.h);
      s.globalCompositeOperation = 'source-over';
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(bbox.x, bbox.y, bbox.w, bbox.h);
    ctx.clip();
    if (o.selection) { tracePolylines(ctx, o.selection); ctx.clip(); }
    ctx.globalAlpha = clamp(o.alpha, 0, 1);
    ctx.globalCompositeOperation = o.erase ? 'destination-out' : blendOp(o.blend);
    ctx.drawImage(src(source), bbox.x, bbox.y, bbox.w, bbox.h, bbox.x, bbox.y, bbox.w, bbox.h);
    if (saved) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(src(saved), bbox.x, bbox.y, bbox.w, bbox.h, bbox.x, bbox.y, bbox.w, bbox.h);
    }
    ctx.restore();
  }

  /** Copy of the layer with the wet buffer composited, for previews. */
  private previewWith(layer: Layer, buffer: Canvas, bbox: Rect | null, o: Parameters<StudioDocument['composeBuffer']>[3]): Canvas {
    const p = this.scratch('preview');
    const ctx = ctx2d(p);
    ctx.globalCompositeOperation = 'copy';
    ctx.globalAlpha = 1;
    ctx.drawImage(src(layer.canvas!), 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (bbox) this.composeBuffer(p, buffer, bbox, o);
    return p;
  }

  private strokeRunner(op: StrokeOp, preview: boolean): Runner {
    const doc = this;
    const layer = this.paintLayer(op.layer);
    const { steps, length, grain } = computeSteps(op);
    const buffer = this.scratch('buffer');
    const bctx = ctx2d(buffer);
    bctx.clearRect(0, 0, this.width, this.height);
    const rgb = `rgb(${op.color[0]},${op.color[1]},${op.color[2]})`;
    const selection = op.selection ? parseSvgPath(op.selection) : null;
    const compose = { alpha: op.brush.opacity * op.color[3], blend: op.blend, erase: op.erase, alphaLock: layer.alphaLock, grain, selection };
    let done = 0;
    let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
    let last: Step | null = null;
    const rect = () => (box ? clampRect(box, doc.width, doc.height, 2) : null);
    const stamp = (upto: number) => {
      for (; done < Math.min(upto, steps.length); done++) {
        const st = steps[done];
        for (const d of st.dabs) {
          drawDab(bctx, doc.tips, d, rgb);
          const r = d.r * 1.5;
          box = box
            ? { x0: Math.min(box.x0, d.x - r), y0: Math.min(box.y0, d.y - r), x1: Math.max(box.x1, d.x + r), y1: Math.max(box.y1, d.y + r) }
            : { x0: d.x - r, y0: d.y - r, x1: d.x + r, y1: d.y + r };
        }
        last = st;
      }
      bctx.globalAlpha = 1;
    };
    const speed = op.brush.preset === 'airbrush' || op.brush.preset === 'watercolor' ? 650 : 900;
    return {
      label: `${op.erase ? 'erase' : op.brush.preset} stroke`, layerId: layer.id,
      units: steps.length,
      durationMs: clamp((length / speed) * 1000, 120, 6000),
      advance(u) {
        stamp(u);
        if (preview) {
          layer.live = () => doc.previewWith(layer, buffer, rect(), compose);
          doc.touch();
        }
      },
      finish() {
        stamp(steps.length);
        const r = rect();
        if (r) doc.composeBuffer(layer.canvas!, buffer, r, compose);
        bctx.clearRect(0, 0, doc.width, doc.height);
        layer.live = null;
        doc.marks++;
        doc.touch(layer);
      },
      cursor: () => (last ? { x: last.x, y: last.y, r: Math.max(2, last.r) } : steps[0] ? { x: steps[0].x, y: steps[0].y, r: steps[0].r } : null),
      guide: () => null,
    };
  }

  private smudgeRunner(op: SmudgeOp): Runner {
    const doc = this;
    const layer = this.paintLayer(op.layer);
    const pts = smoothThrough(op.points.map((p) => [p[0], p[1]]), 1);
    const spacing = Math.max(1, op.size * 0.05);
    const steps: number[][] = [];
    let acc = 0, next = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (acc >= next || i === 0) { steps.push(pts[i]); next = acc + spacing; }
    }
    const D = Math.max(2, Math.ceil(op.size));
    const r = D / 2;
    const patch = this.platform.createCanvas(D, D);
    const mask = this.platform.createCanvas(D, D);
    const pctx = ctx2d(patch), mctx = ctx2d(mask);
    const lctx = ctx2d(layer.canvas!);
    const tip = src(this.tips.tip('round', op.hardness, 0));
    let done = 0;
    const stepTo = (u: number) => {
      for (; done < Math.min(u, steps.length); done++) {
        const [x, y] = steps[done];
        if (done === 0) {
          pctx.drawImage(src(layer.canvas!), x - r, y - r, D, D, 0, 0, D, D);
          continue;
        }
        // layer = lerp(layer, patch, strength × tip) in premultiplied space:
        // remove that fraction of what's there, then add the carried paint back in
        mctx.globalCompositeOperation = 'copy';
        mctx.drawImage(src(patch), 0, 0);
        mctx.globalCompositeOperation = 'destination-in';
        mctx.drawImage(tip, 0, 0, D, D);
        lctx.globalAlpha = op.strength;
        lctx.globalCompositeOperation = 'destination-out';
        lctx.drawImage(tip, x - r, y - r, D, D);
        lctx.globalCompositeOperation = 'lighter';
        lctx.drawImage(src(mask), x - r, y - r);
        lctx.globalCompositeOperation = 'source-over';
        lctx.globalAlpha = 1;
        // the finger picks up some of what is under it: patch = lerp(patch, layer, pickup)
        const pickup = 1 - op.strength * 0.85;
        pctx.globalAlpha = pickup;
        pctx.globalCompositeOperation = 'destination-out';
        pctx.fillRect(0, 0, D, D);
        pctx.globalCompositeOperation = 'lighter';
        pctx.drawImage(src(layer.canvas!), x - r, y - r, D, D, 0, 0, D, D);
        pctx.globalCompositeOperation = 'source-over';
        pctx.globalAlpha = 1;
      }
    };
    return {
      label: 'smudge', layerId: layer.id, units: steps.length,
      durationMs: clamp((acc / 500) * 1000, 150, 5000),
      advance(u) { stepTo(u); doc.touch(layer); },
      finish() { stepTo(steps.length); doc.marks++; doc.touch(layer); },
      cursor: () => { const p = steps[Math.max(0, done - 1)]; return p ? { x: p[0], y: p[1], r } : null; },
      guide: () => null,
    };
  }

  private setPaint(ctx: CanvasRenderingContext2D, paint: Paint, kind: 'fill' | 'stroke') {
    const style = 'color' in paint ? css(paint.color) : makeGradient(ctx, paint.gradient);
    if (kind === 'fill') ctx.fillStyle = style; else ctx.strokeStyle = style;
  }

  /** Shared by path/fill/text: progressive render into the buffer, faded/traced preview. */
  private vectorRunner(
    label: string, layer: Layer, opacity: number, blend: BlendMode, lines: Polyline[] | null,
    draw: (ctx: CanvasRenderingContext2D, progress: number) => void,
    opts: { durationMs: number; guide?: (p: number) => Polyline[] | null; cursor?: (p: number) => { x: number; y: number; r: number } | null; padding: number },
  ): Runner {
    const doc = this;
    const buffer = this.scratch('buffer');
    const bctx = ctx2d(buffer);
    const b = lines ? bounds(lines) : { x0: 0, y0: 0, x1: this.width, y1: this.height };
    const bbox = clampRect(b, this.width, this.height, opts.padding) ?? { x: 0, y: 0, w: 1, h: 1 };
    const compose = { alpha: opacity, blend, alphaLock: layer.alphaLock };
    const UNITS = 1000;
    let progress = 0;
    const paint = (p: number) => {
      bctx.save();
      bctx.clearRect(0, 0, doc.width, doc.height);
      draw(bctx, p);
      bctx.restore();
    };
    return {
      label, layerId: layer.id, units: UNITS, durationMs: opts.durationMs,
      advance(u) {
        progress = clamp(u / UNITS, 0, 1);
        paint(progress);
        layer.live = () => doc.previewWith(layer, buffer, bbox, compose);
        doc.touch();
      },
      finish() {
        paint(1);
        doc.composeBuffer(layer.canvas!, buffer, bbox, compose);
        bctx.clearRect(0, 0, doc.width, doc.height);
        layer.live = null;
        doc.marks++;
        doc.touch(layer);
      },
      cursor: () => opts.cursor?.(progress) ?? null,
      guide: () => (progress < 1 ? opts.guide?.(progress) ?? null : null),
    };
  }

  private pathRunner(op: PathOp): Runner {
    const layer = this.paintLayer(op.layer);
    const lines = parseSvgPath(op.d);
    const L = totalLength(lines);
    const stroke = op.stroke;
    const T = stroke ? 0.82 : 0.7; // portion of time spent tracing the outline
    const pad = (stroke?.width ?? 0) + 4;
    const fillAlpha = (p: number) => (p <= T ? 0 : (p - T) / (1 - T));
    const tip = (p: number) => {
      const pre = prefix(lines, L * Math.min(1, p / T));
      const last = pre[pre.length - 1]?.pts.at(-1);
      return last ? { x: last[0], y: last[1], r: Math.max(2, (stroke?.width ?? 2) / 2) } : null;
    };
    return this.vectorRunner('path', layer, op.opacity, op.blend, lines, (ctx, p) => {
      if (op.fill && p > T) {
        ctx.globalAlpha = p >= 1 ? 1 : fillAlpha(p);
        this.setPaint(ctx, op.fill, 'fill');
        tracePolylines(ctx, lines);
        ctx.fill(op.fillRule);
        ctx.globalAlpha = 1;
      }
      if (stroke) {
        const shown = p >= T ? lines : prefix(lines, L * (p / T));
        applyStroke(ctx, stroke);
        tracePolylines(ctx, shown);
        ctx.stroke();
      }
    }, {
      durationMs: clamp((L / 750) * 1000, 250, 5000) + (op.fill ? 350 : 0),
      padding: pad,
      guide: (p) => (!stroke && p < T ? prefix(lines, L * (p / T)) : null),
      cursor: (p) => (p < T ? tip(p) : null),
    });
  }

  private fillRunner(op: FillOp): Runner {
    const layer = this.paintLayer(op.layer);
    const lines = op.region ? parseSvgPath(op.region) : null;
    const L = lines ? totalLength(lines) : 0;
    const T = lines ? 0.6 : 0;
    return this.vectorRunner('fill', layer, op.opacity, op.blend, lines, (ctx, p) => {
      if (p <= T) return;
      ctx.globalAlpha = p >= 1 ? 1 : (p - T) / (1 - T);
      this.setPaint(ctx, op.paint, 'fill');
      if (lines) { tracePolylines(ctx, lines); ctx.fill('nonzero'); }
      else ctx.fillRect(0, 0, this.width, this.height);
    }, {
      durationMs: lines ? clamp((L / 900) * 1000, 250, 3500) + 400 : 650,
      padding: 2,
      guide: (p) => (lines && p < T ? prefix(lines, L * (p / T)) : null),
    });
  }

  private textRunner(op: TextOp): Runner {
    const layer = this.paintLayer(op.layer);
    const ctx = ctx2d(this.scratch('buffer'));
    ctx.save();
    setFont(ctx, op);
    const lines = wrapText(ctx, op.text, op.maxWidth);
    const lh = op.size * op.lineHeight;
    const widths = lines.map((l) => ctx.measureText(l).width);
    ctx.restore();
    const total = op.text.length;
    const maxW = Math.max(...widths, 1);
    // bounds of the whole block in unrotated space, rotated generously
    const ext = Math.hypot(maxW, lh * lines.length) + op.size * 2;
    const box: Polyline[] = [{ pts: [[op.x - ext, op.y - ext], [op.x + ext, op.y + ext]], closed: false }];
    let cursorPos: { x: number; y: number; r: number } | null = null;
    return this.vectorRunner('text', layer, op.opacity, op.blend, box, (c, p) => {
      let chars = Math.round(total * p);
      setFont(c, op);
      c.textAlign = 'left';
      c.textBaseline = op.baseline;
      c.translate(op.x, op.y);
      c.rotate((op.rotation * Math.PI) / 180);
      this.setPaint(c, op.paint, 'fill');
      if (op.stroke) { c.strokeStyle = css(op.stroke.color); c.lineWidth = op.stroke.width; c.lineJoin = 'round'; }
      for (let i = 0; i < lines.length && chars > 0; i++) {
        const shown = lines[i].slice(0, chars);
        chars -= lines[i].length + 1;
        const x0 = op.align === 'center' ? -widths[i] / 2 : op.align === 'right' || op.align === 'end' ? -widths[i] : 0;
        const y = i * lh;
        if (op.stroke) c.strokeText(shown, x0, y);
        c.fillText(shown, x0, y);
        const w = c.measureText(shown).width;
        const a = (op.rotation * Math.PI) / 180;
        const lx = x0 + w, ly = y;
        cursorPos = { x: op.x + lx * Math.cos(a) - ly * Math.sin(a), y: op.y + lx * Math.sin(a) + ly * Math.cos(a), r: op.size / 3 };
      }
    }, {
      durationMs: clamp(total * 55, 250, 4000),
      padding: 0,
      cursor: (p) => (p < 1 ? cursorPos : null),
    });
  }

  private floodRunner(op: FloodOp, preview: boolean): Runner {
    return this.fadeRunner('flood fill', op.layer, preview, (layer) => {
      const W = this.width, H = this.height;
      const sampleCanvas = op.sampleAll ? this.render() : layer.canvas!;
      const s = ctx2d(sampleCanvas).getImageData(0, 0, W, H).data;
      const x0 = clamp(Math.round(op.x), 0, W - 1), y0 = clamp(Math.round(op.y), 0, H - 1);
      const i0 = (y0 * W + x0) * 4;
      const ref = [s[i0], s[i0 + 1], s[i0 + 2], s[i0 + 3]];
      const tol = op.tolerance * 4.42; // 0..100 → up to ~442 (max rgba distance ~510)
      const match = (i: number) => {
        const dr = s[i] - ref[0], dg = s[i + 1] - ref[1], db = s[i + 2] - ref[2], da = s[i + 3] - ref[3];
        return Math.sqrt(dr * dr + dg * dg + db * db + da * da) <= tol;
      };
      const mask = new Uint8Array(W * H);
      const stack = [x0, y0];
      while (stack.length) {
        const y = stack.pop()!, x = stack.pop()!;
        let l = x;
        while (l >= 0 && !mask[y * W + l] && match((y * W + l) * 4)) l--;
        l++;
        let up = false, dn = false;
        for (let xx = l; xx < W && !mask[y * W + xx] && match((y * W + xx) * 4); xx++) {
          mask[y * W + xx] = 1;
          if (y > 0) { const m = !mask[(y - 1) * W + xx] && match(((y - 1) * W + xx) * 4); if (m && !up) { stack.push(xx, y - 1); up = true; } else if (!m) up = false; }
          if (y < H - 1) { const m = !mask[(y + 1) * W + xx] && match(((y + 1) * W + xx) * 4); if (m && !dn) { stack.push(xx, y + 1); dn = true; } else if (!m) dn = false; }
        }
      }
      // grow the mask by 1px to tuck under anti-aliased line edges
      const grown = new Uint8Array(mask);
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        if (mask[y * W + x]) continue;
        if (mask[y * W + x - 1] || mask[y * W + x + 1] || mask[(y - 1) * W + x] || mask[(y + 1) * W + x]) grown[y * W + x] = 1;
      }
      const buf = this.scratch('buffer');
      const bctx = ctx2d(buf);
      const img = bctx.createImageData(W, H);
      for (let p = 0; p < W * H; p++) if (grown[p]) {
        img.data[p * 4] = op.color[0]; img.data[p * 4 + 1] = op.color[1]; img.data[p * 4 + 2] = op.color[2]; img.data[p * 4 + 3] = 255;
      }
      bctx.putImageData(img, 0, 0);
      this.composeBuffer(layer.canvas!, buf, { x: 0, y: 0, w: W, h: H }, { alpha: op.opacity * op.color[3], blend: 'normal', alphaLock: layer.alphaLock });
      bctx.clearRect(0, 0, W, H);
    }, { x: op.x, y: op.y, r: 6 });
  }

  private filterRunner(op: FilterOp, preview: boolean): Runner {
    return this.fadeRunner(op.filter.kind.replace(/_/g, ' '), op.layer, preview, (layer) => {
      const ctx = ctx2d(layer.canvas!);
      const img = ctx.getImageData(0, 0, this.width, this.height);
      applyFilter(img, op.filter, op.seed);
      if (op.selection) {
        const tmp = this.scratch('filter');
        ctx2d(tmp).putImageData(img, 0, 0);
        ctx.save();
        tracePolylines(ctx, parseSvgPath(op.selection));
        ctx.clip();
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.drawImage(src(tmp), 0, 0);
        ctx.restore();
      } else {
        ctx.putImageData(img, 0, 0);
      }
    }, null, 1100);
  }

  /** Ops computed in one go; viewers see a cross-fade from the old pixels to the new. */
  private fadeRunner(label: string, layerId: string, preview: boolean, compute: (l: Layer) => void, cur: { x: number; y: number; r: number } | null = null, ms = 700): Runner {
    const doc = this;
    const layer = this.paintLayer(layerId);
    let before: Canvas | null = null;
    let computed = false;
    const run = () => {
      if (computed) return;
      if (preview) before = cloneCanvas(doc.platform, layer.canvas!);
      compute(layer);
      computed = true;
    };
    return {
      label, layerId, units: 100, durationMs: ms,
      advance(u) {
        run();
        if (!before) return;
        const t = clamp(u / 100, 0, 1);
        layer.live = () => {
          const p = doc.scratch('preview');
          const ctx = ctx2d(p);
          ctx.globalCompositeOperation = 'copy';
          ctx.globalAlpha = 1 - t;
          ctx.drawImage(src(before!), 0, 0);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = t;
          ctx.drawImage(src(layer.canvas!), 0, 0);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
          return p;
        };
        doc.touch();
      },
      finish() { run(); layer.live = null; before = null; doc.marks++; doc.touch(layer); },
      cursor: () => cur,
      guide: () => null,
    };
  }

  private transformRunner(op: TransformOp): Runner {
    const doc = this;
    const layer = this.paintLayer(op.layer);
    const draw = (target: Canvas, t: number) => {
      const ctx = ctx2d(target);
      ctx.clearRect(0, 0, doc.width, doc.height);
      ctx.save();
      ctx.imageSmoothingQuality = 'high';
      ctx.translate(op.cx + op.dx * t, op.cy + op.dy * t);
      ctx.rotate(((op.rotate * Math.PI) / 180) * t);
      ctx.scale(1 + (op.scaleX - 1) * t, 1 + (op.scaleY - 1) * t);
      ctx.translate(-op.cx, -op.cy);
      ctx.drawImage(src(layer.canvas!), 0, 0);
      ctx.restore();
    };
    return {
      label: 'transform', layerId: layer.id, units: 100, durationMs: 900,
      advance(u) {
        const t = clamp(u / 100, 0, 1);
        layer.live = () => { const p = doc.scratch('preview'); draw(p, ease(t)); return p; };
        doc.touch();
      },
      finish() {
        const out = doc.platform.createCanvas(doc.width, doc.height);
        draw(out, 1);
        layer.canvas = out;
        layer.live = null;
        doc.marks++;
        doc.touch(layer);
      },
      cursor: () => null,
      guide: () => null,
    };
  }

  // ------------------------------------------------------------------ description for the artist

  describe(): string {
    const rows = [...this.layers].reverse().map((l) => {
      const bits = [
        `${l.id}`, `"${l.name}"`,
        l.kind === 'adjustment' ? `adjustment:${l.adjustment?.kind}` : 'pixels',
        l.blend, `${Math.round(l.opacity * 100)}%`,
      ];
      if (!l.visible) bits.push('HIDDEN');
      if (l.alphaLock) bits.push('alpha-locked');
      if (l.clip) bits.push('clipped-to-below');
      return '  ' + bits.join(' · ');
    });
    return `Canvas ${this.width}×${this.height}px. Layers (top → bottom):\n${rows.join('\n') || '  (none — paper is white)'}`;
  }
}

// ------------------------------------------------------------------ helpers

function instant(label: string, layerId: string | null, fn: () => void): Runner {
  let ran = false;
  const go = () => { if (!ran) { ran = true; fn(); } };
  return { label, layerId, units: 1, durationMs: 140, advance(u) { if (u >= 1) go(); }, finish: go, cursor: () => null, guide: () => null };
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function applyStroke(ctx: CanvasRenderingContext2D, s: ShapeStroke) {
  ctx.strokeStyle = css(s.color);
  ctx.lineWidth = s.width;
  ctx.lineCap = s.cap;
  ctx.lineJoin = s.join;
  ctx.setLineDash(s.dash);
}

export function makeGradient(ctx: CanvasRenderingContext2D, g: Gradient): CanvasGradient {
  let grad: CanvasGradient;
  if (g.kind === 'linear') grad = ctx.createLinearGradient(g.x0, g.y0, g.x1, g.y1);
  else if (g.kind === 'radial') grad = ctx.createRadialGradient(g.fx ?? g.cx, g.fy ?? g.cy, 0, g.cx, g.cy, Math.max(0.01, g.r));
  else grad = ctx.createConicGradient((g.angle * Math.PI) / 180, g.cx, g.cy);
  for (const s of g.stops) grad.addColorStop(clamp(s.offset, 0, 1), css(s.color));
  return grad;
}

export function fontString(op: Pick<TextOp, 'italic' | 'weight' | 'size' | 'family'>) {
  return `${op.italic ? 'italic ' : ''}${op.weight} ${op.size}px "${op.family}"`;
}

function setFont(ctx: CanvasRenderingContext2D, op: TextOp) {
  ctx.font = fontString(op);
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${op.letterSpacing}px`;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number | null): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!maxWidth) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && ctx.measureText(test.trimEnd()).width > maxWidth) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}
