// Plays a stream of studio events onto a canvas: ops are animated mark by mark using the
// shared engine, everything else is handed to the UI in order.

import { StudioDocument, type Runner } from '../engine/document.ts';
import type { Platform, Canvas } from '../engine/surface.ts';
import type { StudioEvent } from '../shared/events.ts';

export const browserPlatform: Platform = {
  createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c as unknown as Canvas;
  },
};

type OpEvent = Extract<StudioEvent, { type: 'op' }>;

export interface PlayerHooks {
  /** a non-op event reached the front of the queue (instant = fast-forwarding) */
  onEvent(e: StudioEvent, instant: boolean): void;
  /** an op began animating */
  onOpStart(e: OpEvent, instant: boolean): void;
  onResize(w: number, h: number): void;
  onLayersChanged(): void;
}

export class Player {
  doc = new StudioDocument(browserPlatform);
  speed = 1;
  paused = false;
  /** replay mode paces text events too; live mode shows text as soon as it's reached */
  replay = false;
  processed = 0;
  total = 0;

  private queue: StudioEvent[] = [];
  private active: { runner: Runner; ev: OpEvent; elapsed: number; dur: number } | null = null;
  private textWait = 0;
  private last = performance.now();
  private drawnVersion = -1;
  private raf = 0;
  private size = { w: 0, h: 0 };

  constructor(private art: HTMLCanvasElement, private overlay: HTMLCanvasElement, private hooks: PlayerHooks) {
    this.syncSize();
    const loop = (now: number) => {
      this.tick(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  get busy() { return !!this.active || this.queue.some((e) => e.type === 'op'); }
  get activeLayer() { return this.active?.runner.layerId ?? null; }
  get pending() { return this.queue.length; }

  reset() {
    this.doc = new StudioDocument(browserPlatform);
    this.queue = [];
    this.active = null;
    this.textWait = 0;
    this.processed = 0;
    this.total = 0;
    this.drawnVersion = -1;
    this.syncSize();
    this.hooks.onLayersChanged();
  }

  enqueue(e: StudioEvent) {
    this.queue.push(e);
    this.total++;
  }

  /** Apply events immediately with no animation (joining mid-session, or skipping to the end). */
  fastForward(events: StudioEvent[] = []) {
    for (const e of events) { this.queue.push(e); this.total++; }
    if (this.active) { this.safe(() => this.active!.runner.finish()); this.active = null; this.processed++; }
    while (this.queue.length) this.consume(this.queue.shift()!, true);
    this.hooks.onLayersChanged();
  }

  destroy() { cancelAnimationFrame(this.raf); }

  private safe(fn: () => void) {
    try { fn(); } catch (err) { console.warn('[player] op failed', err); }
  }

  private consume(e: StudioEvent, instant: boolean) {
    this.processed++;
    if (e.type === 'op') {
      this.hooks.onOpStart(e, instant);
      if (instant) {
        this.safe(() => this.doc.apply(e.op));
        if (e.op.t === 'canvas') this.syncSize();
      } else {
        try {
          const runner = this.doc.run(e.op, true);
          this.active = { runner, ev: e, elapsed: 0, dur: runner.durationMs };
          this.processed--; // counted when it completes
        } catch (err) { console.warn('[player] op failed', err); }
      }
      return;
    }
    this.hooks.onEvent(e, instant);
    if (!instant && this.replay && (e.type === 'thought' || e.type === 'speech' || e.type === 'note')) {
      this.textWait = Math.min(2600, 18 * e.text.length + 150);
    }
  }

  private tick(now: number) {
    const dt = Math.min(100, now - this.last);
    this.last = now;
    if (!this.paused) {
      const backlog = this.queue.reduce((n, e) => n + (e.type === 'op' ? 1 : 0), 0);
      // fall behind → speed up, so viewers stay close to the artist
      const factor = this.speed * (this.replay ? 1 : 1 + Math.max(0, backlog - 4) * 0.35);
      let budget = dt * factor;
      let guard = 0;
      while (budget > 0 && guard++ < 500) {
        if (this.active) {
          const a = this.active;
          const need = a.dur - a.elapsed;
          const use = Math.min(need, budget);
          a.elapsed += use;
          budget -= use;
          const p = a.dur > 0 ? a.elapsed / a.dur : 1;
          if (p >= 1) {
            this.safe(() => a.runner.finish());
            this.active = null;
            this.processed++;
            if (a.ev.op.t === 'canvas') this.syncSize();
            if (a.ev.op.t.startsWith('layer') || a.ev.op.t === 'canvas') this.hooks.onLayersChanged();
          } else {
            this.safe(() => a.runner.advance(Math.floor(a.runner.units * easeStroke(p))));
          }
          continue;
        }
        if (this.textWait > 0) {
          const use = Math.min(this.textWait, budget);
          this.textWait -= use;
          budget -= use;
          continue;
        }
        const next = this.queue.shift();
        if (!next) break;
        this.consume(next, false);
      }
    }
    this.draw();
  }

  private syncSize() {
    const { width: w, height: h } = this.doc;
    if (w !== this.size.w || h !== this.size.h) {
      this.size = { w, h };
      this.art.width = w; this.art.height = h;
      this.overlay.width = w; this.overlay.height = h;
      this.drawnVersion = -1;
      this.hooks.onResize(w, h);
    }
  }

  private draw() {
    if (this.doc.version !== this.drawnVersion || this.active) {
      const ctx = this.art.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.art.width, this.art.height);
      ctx.drawImage(this.doc.render() as unknown as CanvasImageSource, 0, 0);
      this.drawnVersion = this.doc.version;
    }
    const o = this.overlay.getContext('2d')!;
    o.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.active) return;
    const px = this.overlay.width / Math.max(1, this.overlay.getBoundingClientRect().width); // canvas px per css px
    const guide = this.active.runner.guide();
    if (guide) {
      o.save();
      o.strokeStyle = 'rgba(0, 170, 255, 0.85)';
      o.lineWidth = 1.25 * px;
      o.setLineDash([5 * px, 4 * px]);
      o.beginPath();
      for (const l of guide) {
        if (!l.pts.length) continue;
        o.moveTo(l.pts[0][0], l.pts[0][1]);
        for (const p of l.pts) o.lineTo(p[0], p[1]);
      }
      o.stroke();
      o.restore();
    }
    const c = this.active.runner.cursor();
    if (c) {
      o.save();
      o.lineWidth = 1.5 * px;
      o.strokeStyle = 'rgba(255,255,255,0.9)';
      o.shadowColor = 'rgba(0,0,0,0.6)';
      o.shadowBlur = 3 * px;
      o.beginPath();
      o.arc(c.x, c.y, Math.max(c.r, 4 * px), 0, Math.PI * 2);
      o.stroke();
      o.fillStyle = 'rgba(255,255,255,0.95)';
      o.beginPath();
      o.arc(c.x, c.y, 1.5 * px, 0, Math.PI * 2);
      o.fill();
      o.restore();
    }
  }
}

/** a hand accelerates into a stroke and slows at the end */
const easeStroke = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) * 0.6 + t * 0.4;
