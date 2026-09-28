import { describe, expect, test } from "bun:test";
import { Hub } from "./hub.ts";
import { IdleExit, type IdleExitDeps, STOP_AFTER_MS, stopAfterFrom } from "./idleExit.ts";

const MIN = 60_000;

/** one pending timer at a time, fired by hand at the clock's reading */
function make(over: Partial<IdleExitDeps> = {}) {
  const hub = new Hub();
  let now = 0;
  let exits = 0;
  let busy = false;
  let pending: { fn: () => void; at: number } | null = null;
  const idle = new IdleExit({
    hub,
    busy: () => busy,
    exit: () => {
      exits++;
    },
    afterMs: 30 * MIN,
    now: () => now,
    setTimer: (fn, ms) => {
      pending = { fn, at: now + ms };
      return pending;
    },
    clearTimer: () => {
      pending = null;
    },
    ...over,
  });
  /** move the clock and fire whatever came due, the way a real timer would */
  const advance = (ms: number) => {
    const until = now + ms;
    while (pending && pending.at <= until) {
      const p: { fn: () => void; at: number } = pending;
      now = p.at;
      pending = null;
      p.fn();
    }
    now = until;
  };
  return {
    hub,
    idle,
    advance,
    exits: () => exits,
    armed: () => pending !== null,
    setBusy: (b: boolean) => {
      busy = b;
    },
  };
}

describe("IdleExit", () => {
  test("a daemon nobody connects to stops after the window", () => {
    const { advance, exits } = make();
    advance(29 * MIN);
    expect(exits()).toBe(0);
    advance(1 * MIN);
    expect(exits()).toBe(1);
  });

  test("a socket open holds it; the clock starts when the last one closes", () => {
    const { idle, advance, exits, armed } = make();
    idle.clients(1);
    expect(armed()).toBe(false);
    advance(3 * 60 * MIN);
    expect(exits()).toBe(0);
    idle.clients(0);
    advance(29 * MIN);
    expect(exits()).toBe(0);
    advance(1 * MIN);
    expect(exits()).toBe(1);
  });

  test("a socket opening before the window is up disarms it", () => {
    const { idle, advance, exits, armed } = make();
    advance(20 * MIN);
    idle.clients(1);
    expect(armed()).toBe(false);
    advance(60 * MIN);
    expect(exits()).toBe(0);
  });

  test("work under way when the window is up defers the stop by a full window after it", () => {
    const { advance, exits, setBusy } = make();
    setBusy(true);
    advance(30 * MIN);
    expect(exits()).toBe(0);
    setBusy(false);
    advance(29 * MIN);
    expect(exits()).toBe(0);
    advance(1 * MIN);
    expect(exits()).toBe(1);
  });

  test("a turn ending with nobody watching starts the clock over", () => {
    const { hub, advance, exits } = make();
    advance(25 * MIN);
    hub.emit("agentStatus", "a", "idle");
    advance(25 * MIN);
    expect(exits()).toBe(0);
    advance(5 * MIN);
    expect(exits()).toBe(1);
  });

  test("a request to a preview counts as activity", () => {
    const { hub, advance, exits } = make();
    advance(25 * MIN);
    hub.emit("previewRequest", "a");
    advance(25 * MIN);
    expect(exits()).toBe(0);
  });

  test("stops once, and not after another shutdown has begun", () => {
    const { idle, advance, exits, armed } = make();
    idle.stop();
    expect(armed()).toBe(false);
    advance(60 * MIN);
    expect(exits()).toBe(0);
  });

  test("a null window never arms", () => {
    const { advance, exits, armed } = make({ afterMs: null });
    expect(armed()).toBe(false);
    advance(24 * 60 * MIN);
    expect(exits()).toBe(0);
  });

  test("the window from the environment: a number, off, or the default; never on a remote, deployed or hand-run daemon", () => {
    const service = { remote: false, inCloud: false, terminal: false };
    expect(stopAfterFrom(undefined, service)).toBe(STOP_AFTER_MS);
    expect(stopAfterFrom("60000", service)).toBe(60_000);
    expect(stopAfterFrom("off", service)).toBeNull();
    expect(stopAfterFrom("nonsense", service)).toBe(STOP_AFTER_MS);
    expect(stopAfterFrom(undefined, { ...service, remote: true })).toBeNull();
    expect(stopAfterFrom(undefined, { ...service, inCloud: true })).toBeNull();
    expect(stopAfterFrom(undefined, { ...service, terminal: true })).toBeNull();
    // said in so many words, the window applies even there
    expect(stopAfterFrom("60000", { ...service, remote: true })).toBe(60_000);
    expect(stopAfterFrom("60000", { ...service, terminal: true })).toBe(60_000);
  });
});
