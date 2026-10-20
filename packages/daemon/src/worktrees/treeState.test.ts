import { describe, expect, test } from "bun:test";
import { Hub } from "../core/hub.ts";
import { waitingFor } from "../core/limiter.ts";
import type { ReadableWorktree } from "./service.ts";
import { type CoreRead, TreeState, type TreeStateDeps } from "./treeState.ts";

/** a core read answered by hand, so a test can mark the tree while a read is out */
function gated() {
  const reads: string[] = [];
  const gates: Array<(c: CoreRead) => void> = [];
  return {
    reads,
    readCore: (r: ReadableWorktree) => {
      reads.push(r.id);
      return new Promise<CoreRead>((resolve) => gates.push(resolve));
    },
    answer: (c: CoreRead) => {
      const g = gates.shift();
      if (!g) throw new Error("no read waiting");
      g(c);
    },
    waiting: () => gates.length,
  };
}

const core = (signature: string, files: string[] = [], ahead?: number): CoreRead => ({
  files: files.map((path) => ({ path, xy: " M" })),
  ...(ahead === undefined ? {} : { ahead, behind: 0 }),
  head: "h1",
  folded: new Set(),
  signature,
});

function world(over: Partial<TreeStateDeps> = {}) {
  const hub = new Hub();
  const frames: string[] = [];
  let rows = 0;
  hub.on("treeChanged", (id) => frames.push(id));
  hub.on("worktreesChanged", () => rows++);
  const interested = new Set<string>();
  const going = new Set<string>();
  const g = gated();
  const readable = (id: string): ReadableWorktree | null =>
    id.startsWith("gone")
      ? null
      : ({
          id,
          repoId: "r",
          path: `/nowhere/${id}`,
          name: id,
          defaultBranch: "main",
          base: "main",
          wt: { kind: "worktree" },
        } as never);
  let now = 1_000_000;
  const deps: TreeStateDeps = {
    hub,
    readable,
    going: (id) => going.has(id),
    interested: (id) => interested.has(id),
    shown: () => false,
    live: () => false,
    trunkBehind: async () => ({}),
    prOpen: () => false,
    afterCore: async () => false,
    rowsOf: () => ["a", "b", "c"],
    readCore: g.readCore,
    readExtras: async (_r, c) => ({ counts: new Map(c.files.map((f) => [f.path, { add: 1, del: 0 }])) }),
    now: () => now,
    editDelayMs: 20,
    shellQuietMs: 40,
    ...over,
  };
  const tree = new TreeState(deps);
  return { tree, hub, frames, rows: () => rows, interested, going, g, tick: (ms: number) => (now += ms) };
}

const flush = () => Bun.sleep(0);

describe("TreeState", () => {
  test("a read is kept, a second ask joins it after the tree is read again, and a row read once with no mark is not read again", async () => {
    const w = world();
    const one = w.tree.refresh("a");
    // the second ask marks the tree: the read out answers for the tree before the ask
    const two = w.tree.refresh("a");
    expect(w.g.reads).toEqual(["a"]);
    w.g.answer(core("s0", ["x"]));
    await flush();
    expect(w.g.reads).toEqual(["a", "a"]);
    w.g.answer(core("s1", ["x"]));
    expect((await one)?.version).toBe(1);
    expect((await two)?.version).toBe(1);
    expect(w.tree.counts("a")).toEqual({ dirty: 1 });
    expect(w.tree.refreshStale(["a"])).toBeNull();
    // a frame built later reads nothing for it
    expect(w.g.reads).toHaveLength(2);
  });

  test("a mark landing mid-read reads again, and the first answer is never stored", async () => {
    const w = world();
    const read = w.tree.refresh("a");
    w.tree.invalidate("a");
    w.g.answer(core("old", ["x"]));
    await flush();
    expect(w.tree.get("a")).toBeUndefined();
    expect(w.g.reads).toEqual(["a", "a"]);
    w.g.answer(core("new", ["x", "y"]));
    expect((await read)?.core.files).toHaveLength(2);
    expect(w.tree.get("a")?.version).toBe(1);
  });

  test("the same tree read again bumps nothing; a new one is a new version with a frame for a subscriber", async () => {
    const w = world();
    w.interested.add("a");
    const first = w.tree.refresh("a");
    w.g.answer(core("s1", ["x"]));
    await first;
    await w.tree.settled();
    // the core frame, then the extras frame once they were read
    expect(w.frames).toEqual(["a", "a"]);
    expect(w.tree.get("a")?.version).toBe(2);
    expect(w.tree.frame("a")?.files).toEqual([{ path: "x", xy: " M", add: 1, del: 0 }]);
    const again = w.tree.refresh("a");
    w.g.answer(core("s1", ["x"]));
    expect((await again)?.moved).toBe(false);
    await w.tree.settled();
    expect(w.frames).toHaveLength(2);
    expect(w.tree.get("a")?.version).toBe(2);
    const moved = w.tree.refresh("a");
    w.g.answer(core("s2", ["x", "y"]));
    expect((await moved)?.moved).toBe(true);
    await w.tree.settled();
    expect(w.frames).toHaveLength(4);
    expect(w.tree.get("a")?.version).toBe(4);
  });

  test("no extras are read for a row nobody is subscribed to, and interest arriving reads them", async () => {
    const w = world();
    const read = w.tree.refresh("a");
    w.g.answer(core("s1", ["x"]));
    await read;
    await w.tree.settled();
    expect(w.frames).toEqual([]);
    expect(w.tree.get("a")?.extras).toBeUndefined();
    w.interested.add("a");
    const frame = await w.tree.current("a", 100);
    expect(frame?.extras).toEqual({ committed: [] });
    expect(frame?.files[0]?.add).toBe(1);
  });

  test("a core that moves while the extras are out drops them and reads them for the new core", async () => {
    const extrasGates: Array<() => void> = [];
    const w = world({
      readExtras: (_r, c) =>
        new Promise((resolve) =>
          extrasGates.push(() => resolve({ counts: new Map(c.files.map((f) => [f.path, { add: 2, del: 0 }])) })),
        ),
    });
    w.interested.add("a");
    const read = w.tree.refresh("a");
    w.g.answer(core("s1", ["x"]));
    await read;
    await flush();
    expect(extrasGates).toHaveLength(1);
    const moved = w.tree.refresh("a");
    w.g.answer(core("s2", ["x", "y"]));
    await moved;
    expect(w.tree.get("a")?.version).toBe(2);
    extrasGates.shift()?.();
    await flush();
    await flush();
    // the stale extras were dropped, and the run for the new core is out
    expect(w.tree.get("a")?.extras).toBeUndefined();
    expect(extrasGates).toHaveLength(1);
    extrasGates.shift()?.();
    await w.tree.settled();
    expect(w.tree.get("a")?.extras?.counts.get("y")).toEqual({ add: 2, del: 0 });
    expect(w.tree.get("a")?.version).toBe(3);
  });

  test("a side effect that moved the tree reads once more before anything is published", async () => {
    let calls = 0;
    const w = world({ afterCore: async () => ++calls === 1 });
    w.interested.add("a");
    const read = w.tree.refresh("a");
    w.g.answer(core("before", ["x"]));
    await flush();
    expect(w.frames).toEqual([]);
    expect(w.g.reads).toEqual(["a", "a"]);
    w.g.answer(core("after", []));
    expect((await read)?.core.files).toEqual([]);
    await w.tree.settled();
    // the tree after the landing is what went out: its core frame and its extras, nothing before
    expect(w.frames).toEqual(["a", "a"]);
    expect(w.tree.frame("a")?.files).toEqual([]);
  });

  test("a row on its way out is neither read nor published", async () => {
    const w = world();
    const read = w.tree.refresh("a");
    w.going.add("a");
    w.g.answer(core("s1", ["x"]));
    expect(await read).toBeNull();
    expect(w.tree.get("a")).toBeUndefined();
    expect(await w.tree.refresh("a")).toBeNull();
    expect(w.g.reads).toEqual(["a"]);
  });

  test("a failed read keeps the last record and says so once", async () => {
    let fail = false;
    const w = world({
      readCore: (r) => (fail ? Promise.reject(new Error("no such directory")) : w.g.readCore(r)),
    });
    const first = w.tree.refresh("a");
    w.g.answer(core("s1", ["x"]));
    await first;
    fail = true;
    expect(await w.tree.refresh("a")).toBeNull();
    const rec = w.tree.get("a");
    expect(rec?.core.files).toHaveLength(1);
    expect(rec?.failedAt).toBeDefined();
    expect(rec?.failures).toBe(1);
    expect(w.tree.counts("a")).toEqual({ dirty: 1 });
  });

  test("a marked row nobody looks at waits for the floor, which reads a few of the oldest per frame", async () => {
    const w = world({ floorBatch: 2 });
    for (const id of ["a", "b", "c", "d"]) {
      const read = w.tree.refresh(id);
      w.g.answer(core(`${id}1`));
      await read;
      w.tick(1000);
    }
    expect(w.tree.refreshStale(["a", "b", "c", "d"])).toBeNull();
    w.tree.invalidateAll();
    expect(w.g.reads).toHaveLength(4);
    const batch = w.tree.refreshStale(["a", "b", "c", "d"]);
    expect(batch).not.toBeNull();
    // the two marked longest ago; the mark is the same instant for all, so the oldest read first
    expect(w.g.reads.slice(4)).toEqual(["a", "b"]);
    w.g.answer(core("a2", ["x"]));
    w.g.answer(core("b1"));
    expect(await batch).toBe(true);
    const rest = w.tree.refreshStale(["a", "b", "c", "d"]);
    expect(w.g.reads.slice(6)).toEqual(["c", "d"]);
    w.g.answer(core("c1"));
    w.g.answer(core("d1"));
    expect(await rest).toBe(false);
    expect(w.tree.refreshStale(["a", "b", "c", "d"])).toBeNull();
  });

  test("a stale-all reads the rows someone looks at now and announces a moved number", async () => {
    const w = world();
    const read = w.tree.refresh("a");
    w.g.answer(core("s1"));
    await read;
    w.interested.add("a");
    w.tree.invalidateAll();
    expect(w.g.reads).toEqual(["a", "a"]);
    w.g.answer(core("s2", ["x"]));
    await w.tree.settled();
    expect(w.rows()).toBe(1);
  });

  test("edits within the wait read once; a settled turn reads at once and takes the wait with it", async () => {
    const w = world();
    w.tree.signal("a", "edit");
    w.tree.signal("a", "edit");
    expect(w.g.reads).toEqual([]);
    await Bun.sleep(30);
    expect(w.g.reads).toEqual(["a"]);
    w.g.answer(core("s1", ["x"]));
    await w.tree.settled();
    expect(w.rows()).toBe(1);
    w.tree.signal("a", "edit");
    w.tree.signal("a", "now");
    await flush();
    expect(w.g.reads).toEqual(["a", "a"]);
    w.g.answer(core("s1", ["x"]));
    await w.tree.settled();
    expect(w.rows()).toBe(1);
    await Bun.sleep(30);
    expect(w.g.reads).toHaveLength(2);
  });

  test("shell output streaming past an agent's edit does not push the edit's read out", async () => {
    const w = world();
    w.tree.signal("a", "edit");
    w.tree.signal("a", "shell");
    await Bun.sleep(30);
    expect(w.g.reads).toEqual(["a"]);
    w.g.answer(core("s1"));
    await w.tree.settled();
    // the other way round the sooner wait stands too
    w.tree.signal("a", "shell");
    w.tree.signal("a", "edit");
    await Bun.sleep(30);
    expect(w.g.reads).toEqual(["a", "a"]);
    w.g.answer(core("s1"));
    await w.tree.settled();
  });

  test("main moving marks every row of the repo and reads only the ones someone looks at", async () => {
    const w = world();
    for (const id of ["a", "b"]) {
      const read = w.tree.refresh(id);
      w.g.answer(core(`${id}1`));
      await read;
    }
    w.interested.add("b");
    w.hub.emit("repoTick", "r");
    await flush();
    expect(w.g.reads).toEqual(["a", "b", "b"]);
    expect(w.tree.get("a")?.staleSince).toBeDefined();
    w.g.answer(core("b2", ["x"]));
    await w.tree.settled();
    expect(w.tree.get("b")?.staleSince).toBeUndefined();
  });

  test("reads take turns in the slots, the rows someone looks at in their own", async () => {
    const w = world({ slots: { fg: 1, bg: 1, extras: 1 } });
    w.interested.add("hot");
    w.tree.refresh("a");
    w.tree.refresh("b");
    w.tree.refresh("c");
    w.tree.refresh("hot");
    await flush();
    expect(waitingFor("tree:bg")).toBe(2);
    expect(waitingFor("tree:fg")).toBe(0);
    expect(w.g.reads).toEqual(["a", "hot"]);
    w.g.answer(core("a1"));
    w.g.answer(core("h1"));
    await flush();
    expect(w.g.reads).toEqual(["a", "hot", "b"]);
    w.g.answer(core("b1"));
    await flush();
    w.g.answer(core("c1"));
    await w.tree.settled();
    expect(waitingFor("tree:bg")).toBe(0);
  });
});
