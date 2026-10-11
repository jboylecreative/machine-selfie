// Spending cap. Every model call's estimated cost (token counts at list price, ignoring caching
// discounts, so it errs high) counts toward a lifetime total: everything this server's archive has
// ever recorded. Once TOTAL_BUDGET_USD is reached the studio closes for good, until the limit is
// raised. The total lives in the archive, so it only means something on persistent storage: when
// running on Railway without a volume the studio refuses to start at all.
import type { SessionMeta } from '../shared/events.ts';

/** why the studio can't run, if it can't */
export type BudgetBlock = 'total' | 'storage' | null;

/** Estimated cost of every session in the archive (the lifetime total so far). */
export function archivedSpend(sessions: SessionMeta[], inputPerM: number, outputPerM: number): number {
  return sessions.reduce((sum, m) => sum + (m.tokens.input * inputPerM + (m.tokens.output + m.tokens.thoughts) * outputPerM) / 1e6, 0);
}

export class Budget {
  /** limit ≤ 0 disables the cap */
  constructor(readonly limit: number, private total: number, readonly persistent: boolean) {}

  add(usd: number) {
    if (usd > 0) this.total += usd;
  }

  get spentTotal() { return this.total; }

  get blocked(): BudgetBlock {
    if (!this.persistent) return 'storage';
    if (this.limit > 0 && this.total >= this.limit) return 'total';
    return null;
  }

  get exhausted() { return this.blocked !== null; }

  describe(): string {
    return `~$${this.total.toFixed(2)} spent of ${this.limit > 0 ? `$${this.limit}` : 'no cap'}`;
  }

  /** human-readable reason for the logs */
  reason(): string {
    switch (this.blocked) {
      case 'storage': return 'no persistent storage — attach a Railway volume (mount path /data) so the spending limit survives deploys';
      case 'total': return `the spending limit of $${this.limit} has been reached (raise TOTAL_BUDGET_USD to reopen)`;
      default: return '';
    }
  }
}
