import { describe, expect, test } from "bun:test";
import type { KeepAwakeMode } from "@toyon/shared";
import { type Demand, idleSleepAssertion, KeepAwake, type KeepAwakeDeps } from "./awake.ts";
import { Hub } from "./hub.ts";

const MIN = 60_000;

/** one pending timer at a time, fired by hand at the clock's reading */
function make(over: Partial<KeepAwakeDeps> = {}) {
  const hub = new Hub();
  let now = 0;
  let demand: Demand = null;
  let held = 0;
  let taken = 0;
  let pending: { fn: () => void; at: number } | null = null;
  const awake = new KeepAwake({
    hub,
    demand: () => demand,
    assert: () => {
      held++;
      taken++;
      return () => {
        held--;
      };
    },
    mode: () => "use",
    answerable: true,
    waitMs: 30 * MIN,
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
  /** an agent's status moving, the way the registry reports it */
  const status = (to: Demand, id = "a") => {
    demand = to;
    hub.emit("agentStatus", id, to ?? "idle");
  };
  return { hub, awake, advance, status, held: () => held, taken: () => taken };
}

describe("KeepAwake", () => {
  test("nothing is held while nothing works", () => {
    const { held, advance } = make();
    advance(60 * MIN);
    expect(held()).toBe(0);
  });

  test("a turn holds the machine up for as long as it runs, and lets go when it ends", () => {
    const { status, held, advance } = make();
    status("working");
    advance(3 * 60 * MIN);
    expect(held()).toBe(1);
    status(null);
    expect(held()).toBe(0);
  });

  test("one assertion however many times the work is reported", () => {
    const { status, hub, held, taken } = make();
    status("working");
    status("working", "b");
    hub.emit("holdsChanged", "a", 1);
    expect(held()).toBe(1);
    expect(taken()).toBe(1);
  });

  test("a question holds it for the window, then lets it sleep", () => {
    const { status, held, advance } = make();
    status("working");
    status("waiting");
    advance(29 * MIN);
    expect(held()).toBe(1);
    advance(1 * MIN);
    expect(held()).toBe(0);
  });

  test("the answer arriving after the window takes the hold again", () => {
    const { status, held, advance } = make();
    status("waiting");
    advance(45 * MIN);
    expect(held()).toBe(0);
    status("working");
    expect(held()).toBe(1);
  });

  test("a second question is waited on for its own full window", () => {
    const { status, held, advance } = make();
    status("waiting");
    advance(20 * MIN);
    status("waiting", "b");
    advance(29 * MIN);
    expect(held()).toBe(1);
    advance(1 * MIN);
    expect(held()).toBe(0);
  });

  test("a hold taken or let go is read again", () => {
    let demand: Demand = null;
    const { hub, held } = make({ demand: () => demand });
    demand = "working";
    hub.emit("holdsChanged", "a", 1);
    expect(held()).toBe(1);
    demand = null;
    hub.emit("holdsChanged", "a", 0);
    expect(held()).toBe(0);
  });

  test("stopping lets go and takes nothing after", () => {
    const { status, awake, held } = make();
    status("working");
    awake.stop();
    expect(held()).toBe(0);
    status("working");
    expect(held()).toBe(0);
  });

  test("with no assertion to take, nothing is held and there is no switch", () => {
    const { status, taken, awake } = make({ assert: null });
    status("working");
    expect(taken()).toBe(0);
    expect(awake.setting()).toBeNull();
  });

  test("a question holds nothing where no other device can answer it", () => {
    const { status, held } = make({ answerable: false });
    status("working");
    expect(held()).toBe(1);
    status("waiting");
    expect(held()).toBe(0);
  });

  test("off lets go at once, and coming back mid-turn takes the hold again", () => {
    let mode: KeepAwakeMode = "use";
    const { status, hub, held, awake } = make({ mode: () => mode });
    status("working");
    mode = "off";
    hub.emit("keepAwakeChanged");
    expect(held()).toBe(0);
    expect(awake.setting()).toBe("off");
    mode = "use";
    hub.emit("keepAwakeChanged");
    expect(held()).toBe(1);
  });

  test("always holds with nothing working, for as long as the daemon runs", () => {
    const { held, advance, awake } = make({ mode: () => "always" });
    expect(held()).toBe(1);
    advance(24 * 60 * MIN);
    expect(held()).toBe(1);
    awake.stop();
    expect(held()).toBe(0);
  });

  test("a shell open from another device holds it, and for the window after it leaves", () => {
    const { awake, held, advance } = make();
    awake.remoteShells(1);
    advance(3 * 60 * MIN);
    expect(held()).toBe(1);
    awake.remoteShells(0);
    advance(29 * MIN);
    expect(held()).toBe(1);
    advance(1 * MIN);
    expect(held()).toBe(0);
  });

  test("a device coming back inside the window keeps the one hold", () => {
    const { awake, held, taken, advance } = make();
    awake.remoteShells(1);
    awake.remoteShells(0);
    advance(10 * MIN);
    awake.remoteShells(1);
    advance(60 * MIN);
    expect(held()).toBe(1);
    expect(taken()).toBe(1);
  });

  test("off holds nothing for a device either", () => {
    const { awake, held } = make({ mode: () => "off" });
    awake.remoteShells(1);
    expect(held()).toBe(0);
  });
});

describe("idleSleepAssertion", () => {
  test("macOS only, and off when asked", () => {
    expect(idleSleepAssertion(undefined, "darwin")).not.toBeNull();
    expect(idleSleepAssertion("off", "darwin")).toBeNull();
    expect(idleSleepAssertion(undefined, "linux")).toBeNull();
  });
});
