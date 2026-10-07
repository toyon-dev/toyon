// One-time codes that let a page served by another machine open a preview here. The desk there
// mounts one frame per worktree it has visited, and each frame's first request carries its own
// code, so several live at once; a code is spent on first use and worth nothing a minute later.
// Memory only, like the pairing codes: a daemon restart invalidates every code, and the page asks
// for another.

import { randomBytes } from "node:crypto";
import { sameSecret } from "./remote.ts";

export interface GrantCodesOpts {
  /** how long a code can be spent after it is minted */
  ttlMs?: number;
  /** how many codes live at once; minting past it retires the oldest */
  max?: number;
  now?: () => number;
}

export class GrantCodes {
  private live: { code: string; until: number }[] = [];
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: GrantCodesOpts = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.max = opts.max ?? 32;
    this.now = opts.now ?? Date.now;
  }

  /** a fresh code. 72 bits: guessing one inside its minute is hopeless. */
  mint(): { code: string; ms: number } {
    this.sweep();
    const code = randomBytes(9).toString("base64url");
    this.live.push({ code, until: this.now() + this.ttlMs });
    if (this.live.length > this.max) this.live.splice(0, this.live.length - this.max);
    return { code, ms: this.ttlMs };
  }

  /** whether `code` is live; a right answer spends it. A wrong guess spends nothing, since the
   * codes are independent and one guess says nothing about another. */
  redeem(code: string): boolean {
    this.sweep();
    const i = this.live.findIndex((g) => sameSecret(code, g.code));
    if (i < 0) return false;
    this.live.splice(i, 1);
    return true;
  }

  private sweep() {
    const t = this.now();
    this.live = this.live.filter((g) => t < g.until);
  }
}
