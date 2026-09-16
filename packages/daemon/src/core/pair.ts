// One-time pairing codes (see shared/pair.ts). Memory only: a code outlives neither two minutes nor
// the daemon, and there is at most one, because a desk shows one QR at a time and a second mint
// means the first was not scanned.

import { randomBytes } from "node:crypto";
import { PAIR_TTL_MS } from "@toyon/shared";
import { sameSecret } from "./remote.ts";

export class PairCodes {
  private live: { code: string; until: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** a fresh code, retiring any other. 72 bits: guessing one inside its two minutes is hopeless. */
  mint(): { code: string; ms: number } {
    const code = randomBytes(9).toString("base64url");
    this.live = { code, until: this.now() + PAIR_TTL_MS };
    return { code, ms: PAIR_TTL_MS };
  }

  /** Whether `code` is the live one. Any attempt spends it, right or wrong: a wrong guess costs a
   * person one more scan, and leaves a guesser nothing to keep trying against. */
  redeem(code: string): boolean {
    const live = this.live;
    this.live = null;
    return live !== null && this.now() < live.until && sameSecret(code, live.code);
  }
}
