import { afterEach, describe, expect, test } from "bun:test";
import type { AgentStatus, ProcState, RepoInfo, WorktreeInfo } from "@toyon/shared";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { type IdleDeps, IdlePolicy, sleepMsFrom } from "./idle.ts";
import type { MemorySignal } from "./memory.ts";

const S = 10_000;

const repo: RepoInfo = {
  id: "r",
  path: "/nowhere",
  name: "x",
  defaultBranch: "main",
  config: { run: { web: "true" } },
  configFile: ".toyon/settings.json",
  needsSetup: false,
};
const row = (id: string, extra: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  id,
  repoId: "r",
  path: `/nowhere/${id}`,
  branch: `toyon/${id}`,
  kind: "worktree",
  proxyPort: 1,
  title: id,
  createdAt: 0,
  ...extra,
});

/** a runtime as the policy sees it: procs with states, an agent with a status, holds, and what
 * it was told to sleep */
class FakeRuntime {
  procs = new Map<string, { asleep: boolean; states: ProcState[] }>();
  agents = new Map<string, { status: AgentStatus; queueItems: string[] }>();
  holds = new Map<string, number>();
  slept: string[] = [];
  awaited: Array<[string, number]> = [];
  up(id: string, status: ProcState["status"] = "running") {
    this.procs.set(id, { asleep: false, states: [{ name: "web", command: "true", port: 1, status }] });
  }
  get(id: string) {
    const p = this.procs.get(id);
    if (!p) return undefined;
    return { procs: { asleep: p.asleep, states: () => p.states.map((s) => ({ ...s })) } } as never;
  }
  agentFor(id: string) {
    return this.agents.get(id) as never;
  }
  holdCount(id: string) {
    return this.holds.get(id) ?? 0;
  }
  async sleep(id: string) {
    const p = this.procs.get(id);
    if (!p) return;
    p.asleep = true;
    for (const s of p.states) s.status = "asleep";
    this.slept.push(id);
  }
  awake() {
    return [...this.procs].filter(([, p]) => !p.asleep).map(([id]) => ({ id, pgids: [Number(id.charCodeAt(0))] }));
  }
  async awaitPreview(id: string, ms: number) {
    this.awaited.push([id, ms]);
    return null;
  }
  isAsleep(id: string) {
    return this.procs.get(id)?.asleep ?? false;
  }
}

let cleanup = () => {};
afterEach(() => cleanup());

function make(opts: Partial<IdleDeps> & { worktrees?: WorktreeInfo[] } = {}) {
  const t = tmpRepo();
  cleanup = t.cleanup;
  const state = new StateStore(t.paths, { repos: [repo], worktrees: opts.worktrees ?? [row("a")], sessions: {} });
  const hub = new Hub();
  const runtime = new FakeRuntime();
  for (const w of state.worktrees) runtime.up(w.id);
  let clock = 1_000_000;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nextTimer = 1;
  const woken: string[] = [];
  const warmed: string[] = [];
  const policy = new IdlePolicy({
    runtime,
    state,
    hub,
    wake: (id) => {
      woken.push(id);
      const p = runtime.procs.get(id);
      if (p) {
        p.asleep = false;
        for (const s of p.states) s.status = "running";
      }
    },
    warmSpare: (repoId) => warmed.push(repoId),
    sleepMs: S,
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.push({ fn, at: clock + ms, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval: () => {},
    ...opts,
  });
  /** move the clock, firing timers in order as they come due (a firing may arm another) */
  const advance = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((x, y) => x.at - y.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      clock = Math.max(clock, due.at);
      due.fn();
    }
    clock = until;
  };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  // what the registry emits once procs are up, which is when a clock first arms
  hub.emit("worktreesChanged");
  return { state, hub, runtime, policy, advance, woken, warmed, settle, timers };
}

describe("IdlePolicy clock", () => {
  test("a worktree sleeps the window after its tab leaves it, and not while a tab shows it", () => {
    const { policy, runtime, advance, woken } = make();
    policy.view("tab", "a");
    expect(woken).toEqual(["a"]);
    advance(S * 3);
    expect(runtime.slept).toEqual([]);
    policy.view("tab", null);
    advance(S - 1);
    expect(runtime.slept).toEqual([]);
    advance(2);
    expect(runtime.slept).toEqual(["a"]);
  });

  test("a hidden tab's worktree sleeps like an unviewed one; a second tab keeps it awake", () => {
    const { policy, runtime, advance } = make();
    policy.view("t1", "a");
    policy.view("t2", "a");
    policy.view("t1", null);
    advance(S * 2);
    expect(runtime.slept).toEqual([]);
    policy.drop("t2");
    advance(S + 1);
    expect(runtime.slept).toEqual(["a"]);
  });

  test("viewing an asleep worktree wakes it and clears the clock", () => {
    const { policy, runtime, advance, woken } = make();
    policy.view("tab", "a");
    policy.view("tab", null);
    advance(S + 1);
    expect(runtime.slept).toEqual(["a"]);
    policy.view("tab", "a");
    expect(woken).toEqual(["a", "a"]);
    expect(runtime.isAsleep("a")).toBe(false);
    advance(S * 3);
    expect(runtime.slept).toEqual(["a"]);
  });

  test("a working agent, a queued message, or a hold keeps it awake; the clock starts when they end", () => {
    const { runtime, hub, advance } = make();
    runtime.agents.set("a", { status: "working", queueItems: [] });
    hub.emit("agentStatus", "a", "working");
    advance(S * 2);
    expect(runtime.slept).toEqual([]);
    runtime.agents.set("a", { status: "idle", queueItems: ["next"] });
    hub.emit("agentStatus", "a", "idle");
    advance(S * 2);
    expect(runtime.slept).toEqual([]);
    runtime.agents.set("a", { status: "idle", queueItems: [] });
    runtime.holds.set("a", 1);
    hub.emit("holdsChanged", "a", 1);
    advance(S * 2);
    expect(runtime.slept).toEqual([]);
    runtime.holds.set("a", 0);
    hub.emit("holdsChanged", "a", 0);
    advance(S - 1);
    expect(runtime.slept).toEqual([]);
    advance(2);
    expect(runtime.slept).toEqual(["a"]);
  });

  test("a proc still starting is not put to sleep; it sleeps once it runs", () => {
    const { runtime, hub, advance } = make();
    runtime.up("a", "starting");
    hub.emit("worktreesChanged");
    advance(S * 2);
    expect(runtime.slept).toEqual([]);
    runtime.up("a", "running");
    hub.emit("proc", "a", { name: "web", command: "true", port: 1, status: "running" });
    advance(1);
    expect(runtime.slept).toEqual(["a"]);
  });

  test("a request to the preview starts the clock over", () => {
    const { runtime, hub, advance } = make();
    advance(S - 1);
    hub.emit("previewRequest", "a");
    advance(2);
    expect(runtime.slept).toEqual([]);
    advance(S);
    expect(runtime.slept).toEqual(["a"]);
  });

  test("off never sleeps on the clock", () => {
    const { runtime, advance, timers } = make({ sleepMs: null });
    advance(S * 100);
    expect(runtime.slept).toEqual([]);
    expect(timers).toEqual([]);
  });

  test("the default is two hours here and five minutes in the cloud; the variable overrides both", () => {
    expect(sleepMsFrom(undefined, false)).toBe(2 * 60 * 60_000);
    expect(sleepMsFrom(undefined, true)).toBe(5 * 60_000);
    expect(sleepMsFrom("15000", true)).toBe(15_000);
    expect(sleepMsFrom("off", false)).toBeNull();
    expect(sleepMsFrom("nonsense", false)).toBe(2 * 60 * 60_000);
  });

  test("a removed worktree drops out; its timer never fires", () => {
    const { policy, runtime, hub, state, advance } = make();
    policy.view("tab", "a");
    policy.view("tab", null);
    state.removeWorktree("a");
    hub.emit("worktreesChanged");
    advance(S * 2);
    expect(runtime.slept).toEqual([]);
  });
});

describe("IdlePolicy and the spare", () => {
  const withSpare = () => make({ worktrees: [row("a"), row("b"), row("s", { kind: "spare" })] });

  test("viewing a worktree brings its repo's spare up behind it, and keeps it awake", async () => {
    const { policy, runtime, advance, woken, warmed, settle } = withSpare();
    policy.view("tab", "a");
    await settle();
    expect(woken).toEqual(["a", "s"]);
    expect(warmed).toEqual(["r"]);
    // the spare waited on the viewed worktree's port before starting
    expect(runtime.awaited).toEqual([["a", 3000]]);
    advance(S * 3);
    // b, never shown, sleeps on its own clock; the shown one and the spare do not
    expect(runtime.slept).toEqual(["b"]);
  });

  test("the spare sleeps on its repo's clock: when the last sibling is left, and not before", async () => {
    const { policy, runtime, hub, advance, settle } = withSpare();
    policy.view("tab", "a");
    await settle();
    policy.view("tab", "b");
    await settle();
    advance(S + 1);
    // a slept, b is shown, the spare rests with the repo
    expect(runtime.slept).toEqual(["a"]);
    policy.view("tab", null);
    advance(S + 1);
    expect(runtime.slept.sort()).toEqual(["a", "b", "s"]);
    // back up: activity on a sibling, a request to its preview say, is the spare's activity too
    policy.view("tab", "b");
    await settle();
    policy.view("tab", null);
    advance(S - 1);
    hub.emit("previewRequest", "b");
    advance(S - 1);
    expect(runtime.slept.filter((id) => id === "s")).toHaveLength(1);
    advance(2);
    expect(runtime.slept.filter((id) => id === "s")).toHaveLength(2);
  });
});

describe("IdlePolicy under memory pressure", () => {
  const tight: MemorySignal = { tight: true, backstop: false, why: "memory pressure warn with 9% available" };

  test("the least recently used idle worktree sleeps, one per check; viewed and held ones never", async () => {
    const { policy, runtime, hub, advance } = make({
      worktrees: [row("a"), row("b"), row("c"), row("d")],
      memory: async () => tight,
    });
    policy.view("tab", "a");
    advance(10);
    hub.emit("previewRequest", "b");
    advance(10);
    hub.emit("previewRequest", "c");
    runtime.holds.set("d", 1);
    await policy.checkPressure();
    expect(runtime.slept).toEqual(["b"]);
    await policy.checkPressure();
    expect(runtime.slept).toEqual(["b", "c"]);
    // nothing left that may sleep: a is shown and d is held
    await policy.checkPressure();
    expect(runtime.slept).toEqual(["b", "c"]);
  });

  test("a machine that is fine sleeps nothing", async () => {
    const { policy, runtime } = make({
      memory: async () => ({ tight: false, backstop: false, why: "memory pressure normal with 49% available" }),
    });
    await policy.checkPressure();
    expect(runtime.slept).toEqual([]);
  });

  test("a platform with no reading sleeps nothing", async () => {
    const { policy, runtime } = make({ memory: async () => null });
    await policy.checkPressure();
    expect(runtime.slept).toEqual([]);
  });

  test("the backstop reading names what it would sleep and sleeps nothing", async () => {
    const { policy, runtime } = make({
      memory: async () => ({ tight: false, backstop: true, why: "memory pressure normal with 12% available" }),
    });
    await policy.checkPressure();
    expect(runtime.slept).toEqual([]);
  });

  test("costs are sampled per awake worktree and cleared when it sleeps", async () => {
    const { policy, runtime, advance } = make({
      worktrees: [row("a"), row("b")],
      costs: async (pgids) => new Map(pgids.map((g) => [g, g * 10])),
    });
    await policy.sampleCosts();
    expect(policy.costs()).toEqual({ a: "a".charCodeAt(0) * 10, b: "b".charCodeAt(0) * 10 });
    advance(S + 1);
    expect(runtime.slept.sort()).toEqual(["a", "b"]);
    expect(policy.costs()).toEqual({});
  });
});

describe("IdlePolicy wakes", () => {
  test("a turn settling wakes a worktree someone looked at recently, and not one nobody has", () => {
    const { policy, hub, woken, advance } = make({ worktrees: [row("a"), row("b")] });
    policy.view("tab", "a");
    policy.view("tab", null);
    woken.length = 0;
    hub.emit("turnSettled", "a", { at: 0, end: "done", facts: { turns: 1, edits: 0, toolErrors: 0 } });
    hub.emit("turnSettled", "b", { at: 0, end: "done", facts: { turns: 1, edits: 0, toolErrors: 0 } });
    expect(woken).toEqual(["a"]);
    // past the window, a is no longer worth a boot either
    advance(S + 1);
    woken.length = 0;
    hub.emit("turnSettled", "a", { at: 0, end: "done", facts: { turns: 1, edits: 0, toolErrors: 0 } });
    expect(woken).toEqual([]);
  });

  test("the view stamp follows a tab that stays: refreshed on the minute tick, on leaving, and at shutdown", async () => {
    const { policy, state, advance } = make({ worktrees: [row("a"), row("b")] });
    policy.view("t1", "a");
    policy.view("t2", "b");
    expect(state.worktree("a")?.viewedAt).toBe(1_000_000);
    advance(S * 3);
    // the cost sample's tick, while both tabs sit where they are
    await policy.sampleCosts();
    expect(state.worktree("a")?.viewedAt).toBe(1_000_000 + S * 3);
    expect(state.worktree("b")?.viewedAt).toBe(1_000_000 + S * 3);
    advance(S);
    policy.view("t1", null);
    expect(state.worktree("a")?.viewedAt).toBe(1_000_000 + S * 4);
    advance(S);
    policy.shutdown();
    expect(state.worktree("a")?.viewedAt).toBe(1_000_000 + S * 4);
    expect(state.worktree("b")?.viewedAt).toBe(1_000_000 + S * 5);
    expect(policy.recentlyViewed("b")).toBe(true);
  });

  test("boot brings back what was viewed inside the window, newest first, one behind the other", async () => {
    const now = 1_000_000;
    const { policy, woken, runtime, settle } = make({
      worktrees: [
        row("old", { viewedAt: now - S - 1 }),
        row("newer", { viewedAt: now - 100 }),
        row("newest", { viewedAt: now - 10 }),
        row("never"),
        row("s", { kind: "spare", viewedAt: now }),
      ],
    });
    policy.boot();
    await settle();
    expect(woken).toEqual(["newest", "newer"]);
    expect(runtime.awaited).toEqual([
      ["newest", 3000],
      ["newer", 3000],
    ]);
  });
});
