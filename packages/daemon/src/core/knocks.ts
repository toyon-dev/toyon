// The knocks waiting on this machine (see shared/knock.ts). Memory only: a daemon restart drops
// every knock, and the device asks again on its next poll. The id is what the knocking device
// polls with and nobody else sees, so it is as long as a secret; the words are what the person
// matches across two screens, so they are short and never reused while both knocks wait.

import { randomBytes, randomInt } from "node:crypto";
import {
  KNOCK_MAX,
  KNOCK_PER_CLIENT,
  KNOCK_TTL_MS,
  type Knock,
  type Knocked,
  type KnockState,
  knockWord,
} from "@toyon/shared";
import type { Hub } from "./hub.ts";

interface Waiting extends Knock {
  since: number;
  until: number;
  answer: "let-in" | "refused" | null;
  /** the address the knock came from through a front, or null on the loopback name */
  client: string | null;
}

export class Knocks {
  private live: Waiting[] = [];

  constructor(
    /** every change to what waits is `knocksChanged`: the shells' cards follow it */
    private readonly hub: Pick<Hub, "emit">,
    private readonly now: () => number = Date.now,
  ) {}

  private changed(): void {
    this.hub.emit("knocksChanged");
  }

  /** A new knock from a page on `from` (null for a page this machine served), by the device at
   * `client` (null on the loopback name, where only this machine's own processes reach). Null
   * when too many wait already, or that client holds its share of them. */
  knock(from: string | null, client: string | null = null): Knocked | null {
    this.sweep();
    const waiting = this.live.filter((k) => k.answer === null);
    if (waiting.length >= KNOCK_MAX) return null;
    if (client !== null && waiting.filter((k) => k.client === client).length >= KNOCK_PER_CLIENT) return null;
    const id = randomBytes(9).toString("base64url");
    let word = knockWord(randomInt);
    // two knocks with one name would make the person's match a coin toss
    while (this.live.some((k) => k.word === word)) word = knockWord(randomInt);
    this.live.push({ id, word, from, client, since: this.now(), until: this.now() + KNOCK_TTL_MS, answer: null });
    this.changed();
    return { id, word };
  }

  /** the knocks nobody has answered, oldest first */
  pending(): Knock[] {
    this.sweep();
    return this.live.filter((k) => k.answer === null).map(({ id, word, from }) => ({ id, word, from }));
  }

  /** Answer a knock. False for one that is not waiting (answered, expired, or never here). */
  answer(id: string, letIn: boolean): boolean {
    this.sweep();
    const k = this.live.find((x) => x.id === id && x.answer === null);
    if (!k) return false;
    k.answer = letIn ? "let-in" : "refused";
    // an answer waits for the device's next poll, not for its five minutes
    k.until = this.now() + ANSWER_HOLD_MS;
    this.changed();
    return true;
  }

  /** What the knocking device sees. An answer is given once and the knock is gone with it, so a
   * token is handed out exactly one time; null for a knock that is not here. */
  poll(id: string): KnockState["state"] | null {
    this.sweep();
    const i = this.live.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const k = this.live[i]!;
    if (k.answer === null) return "waiting";
    this.live.splice(i, 1);
    return k.answer;
  }

  private sweep() {
    const t = this.now();
    const before = this.live.length;
    this.live = this.live.filter((k) => t < k.until);
    if (this.live.length !== before) this.changed();
  }
}

/** how long an answered knock waits to be collected: the device polls every two seconds, and a
 * token left waiting longer is one nobody is coming for */
const ANSWER_HOLD_MS = 30_000;
