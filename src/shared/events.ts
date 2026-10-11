// Messages streamed from the studio to viewers (and archived for replay).
import type { Op } from '../engine/ops.ts';

export type EventBody =
  | { type: 'session'; id: string; number: number; startedAt: string; model: string }
  | { type: 'turn'; n: number }
  | { type: 'thought'; text: string }
  | { type: 'speech'; text: string }
  | { type: 'op'; seq: number; tool: string; op: Op }
  | { type: 'note'; text: string }
  | { type: 'look'; region: { x: number; y: number; width: number; height: number } | null; grid: boolean }
  | { type: 'chance'; values: number[] }
  | { type: 'tool_error'; tool: string; error: string }
  | { type: 'finished'; title: string; statement: string }
  | { type: 'ended'; reason: string };

/** t = ms since the session started */
export type StudioEvent = { t: number } & EventBody;

export type StudioState =
  | { phase: 'working'; sessionId: string; work: number; of: number }
  | { phase: 'resting'; nextAt: number; lastId: string | null; work: number; of: number }
  | { phase: 'stopping' }
  /** completedRun: the last run made all its works (the button offers to continue) */
  /** blocked: why the studio can't start (spending limit reached, or no persistent storage) */
  | { phase: 'idle'; worksPerRun: number; completedRun: boolean; blocked: 'total' | 'storage' | null };

/** `owner`: this viewer's tab started the running studio (closing it stops the studio).
 *  `serverTime`: the server's clock, so viewers with a wrong clock can still show correct countdowns. */
export type ServerMessage =
  | { type: 'hello'; state: StudioState; owner: boolean; events: StudioEvent[]; serverTime: number; spend: Spend }
  /** the running cost estimate, sent after every model call */
  | { type: 'spend'; spend: Spend }
  | { type: 'event'; event: StudioEvent }
  | { type: 'state'; state: StudioState; owner: boolean; serverTime: number };

/** estimated spending so far vs the cap (limit 0 = no cap) */
export interface Spend { spent: number; limit: number }

/** `tab` is a per-tab id kept in sessionStorage: it survives reloads but not closing the tab */
export type ClientMessage =
  | { type: 'identify'; tab: string }
  | { type: 'start'; tab: string }
  /** owner only: abandon the current work (or skip the rest) and move on to the next work */
  | { type: 'next'; tab: string };

export interface SessionMeta {
  id: string;
  number: number;
  model: string;
  startedAt: string;
  endedAt: string | null;
  title: string | null;
  statement: string | null;
  status: 'working' | 'finished' | 'ended';
  endReason?: string;
  turns: number;
  actions: number;
  width: number;
  height: number;
  tokens: { input: number; output: number; thoughts: number };
  /** estimated cost at list price (no caching discount) */
  costUsd?: number;
}
