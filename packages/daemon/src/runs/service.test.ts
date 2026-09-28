import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunState, WorktreeInfo } from "@toyon/shared";
import { Hub } from "../core/hub.ts";
import { ensureDirs, makePaths } from "../core/paths.ts";
import { StateStore } from "../core/state.ts";
import { RunService } from "./service.ts";

const home = mkdtempSync(join(tmpdir(), "toyon-runs-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function world(opts: { runs?: RunState[]; alive?: (pid: number) => boolean; ids?: string[] } = {}) {
  const paths = makePaths(mkdtempSync(join(home, "h-")));
  ensureDirs(paths);
  const wt: WorktreeInfo = {
    id: "w1",
    repoId: "r1",
    path: "/nowhere",
    branch: "b",
    kind: "worktree",
    proxyPort: 1,
    title: "t",
    createdAt: 0,
    ...(opts.runs ? { runs: opts.runs } : {}),
  };
  const worktrees = (opts.ids ?? ["w1"]).map((id) => ({ ...wt, id }));
  const state = new StateStore(paths, { repos: [], worktrees, sessions: {} });
  const hub = new Hub();
  const killed: number[] = [];
  const runs = new RunService({
    state,
    hub,
    alive: opts.alive ?? (() => false),
    kill: async (pid) => {
      killed.push(pid);
    },
  });
  const row = (id = "w1") => state.worktree(id)?.runs;
  return { runs, row, killed, state };
}

/** the check run's status on a row, or nothing when none stands there */
const checkStatus = (w: ReturnType<typeof world>, id: string) => w.row(id)?.find((r) => r.kind === "check")?.status;

describe("RunService", () => {
  test("a run stands on the record from begin to finish, with its stage and pid", () => {
    const w = world();
    const h = w.runs.begin("w1", "setup", { timeoutMs: 1000, stage: "bun install (1 of 2)" });
    expect(w.row()).toEqual([
      { kind: "setup", status: "running", since: expect.any(Number), timeoutMs: 1000, stage: "bun install (1 of 2)" },
    ]);
    h.spawned(42, () => {});
    expect(w.row()?.[0]?.pid).toBe(42);
    h.stage("bun install (2 of 2)");
    expect(w.row()?.[0]?.stage).toBe("bun install (2 of 2)");
    h.finish(0);
    expect(w.row()).toBeUndefined();
    expect(w.runs.of("w1", "setup")).toBeUndefined();
  });

  test("a slot admits at most max of a key at once, the rest queued in order; one dropped while queued never starts", async () => {
    const ids = ["w1", "w2", "w3", "w4"];
    const w = world({ ids });
    const slot = { key: "/repo", max: 2 };
    const h = ids.map((id) => w.runs.begin(id, "check", { timeoutMs: 1000, slot }));
    expect(await h[0]?.admitted).toBe(true);
    expect(await h[1]?.admitted).toBe(true);
    await Bun.sleep(1);
    expect(ids.map((id) => checkStatus(w, id))).toEqual(["running", "running", "queued", "queued"]);
    // the third is dropped where it stands; when a slot frees it is passed over for the fourth
    w.runs.drop("w3", "check");
    expect(checkStatus(w, "w3")).toBeUndefined();
    h[0]?.finish(0);
    expect(await h[2]?.admitted).toBe(false);
    expect(await h[3]?.admitted).toBe(true);
    expect(ids.map((id) => checkStatus(w, id))).toEqual([undefined, "running", undefined, "running"]);
    // a run over at the ceiling lets go of its slot like one that finished
    h[1]?.finish("timeout");
    h[3]?.finish(0);
    const next = w.runs.begin("w1", "check", { timeoutMs: 1000, slot });
    expect(await next.admitted).toBe(true);
    expect(checkStatus(w, "w1")).toBe("running");
    next.finish(0);
  });

  test("a queued run counts its time from when it starts", async () => {
    const w = world();
    const h = w.runs.begin("w1", "check", { timeoutMs: 1000, queued: true });
    const asked = w.row()?.[0]?.since ?? 0;
    expect(w.row()?.[0]?.status).toBe("queued");
    await Bun.sleep(5);
    h.start();
    expect(w.row()?.[0]?.status).toBe("running");
    expect(w.row()?.[0]?.since).toBeGreaterThan(asked);
  });

  test("killed at the ceiling reads as terminated with the ceiling in words", () => {
    const w = world();
    const h = w.runs.begin("w1", "commit", { timeoutMs: 30 * 60_000 });
    h.spawned(7, () => {});
    h.finish("timeout");
    expect(w.row()?.[0]).toMatchObject({ kind: "commit", status: "terminated", why: "gave up after 30 minutes" });
    expect(w.row()?.[0]?.pid).toBeUndefined();
  });

  test("a stop kills through the handle it was given and names itself as the reason", () => {
    const w = world();
    const h = w.runs.begin("w1", "check", { timeoutMs: 1000 });
    let stops = 0;
    expect(w.runs.stop("w1", "check")).toBe(false);
    h.spawned(7, () => {
      stops++;
      h.finish("SIGTERM");
    });
    expect(w.runs.stop("w1", "check", "stopped from the box")).toBe(true);
    expect(stops).toBe(1);
    expect(w.row()?.[0]).toMatchObject({ status: "terminated", why: "stopped from the box" });
  });

  test("a new run of the kind takes the old entry's place, and the old handle is dead", () => {
    const w = world();
    const old = w.runs.begin("w1", "check", { timeoutMs: 1000 });
    w.runs.begin("w1", "check", { timeoutMs: 2000 });
    old.stage("late");
    old.finish("timeout");
    expect(w.row()).toEqual([{ kind: "check", status: "running", since: expect.any(Number), timeoutMs: 2000 }]);
  });

  test("drop kills a running one and takes it off the row; the finish then finds nothing", () => {
    const w = world();
    const h = w.runs.begin("w1", "check", { timeoutMs: 1000 });
    let stopped = false;
    h.spawned(7, () => {
      stopped = true;
    });
    w.runs.drop("w1", "check");
    expect(stopped).toBe(true);
    expect(w.row()).toBeUndefined();
    h.finish("SIGTERM");
    expect(w.row()).toBeUndefined();
  });

  test("boot keeps what is still alive as detached and drops what is gone", () => {
    const w = world({
      runs: [
        { kind: "commit", status: "running", since: 1, timeoutMs: 1000, pid: 100 },
        { kind: "check", status: "running", since: 1, timeoutMs: 1000, pid: 200 },
        { kind: "setup", status: "terminated", since: 1, timeoutMs: 1000, why: "gave up after 10 minutes" },
      ],
      alive: (pid) => pid === 100,
    });
    w.runs.boot();
    expect(w.row()).toEqual([
      { kind: "commit", status: "detached", since: 1, timeoutMs: 1000, pid: 100 },
      { kind: "setup", status: "terminated", since: 1, timeoutMs: 1000, why: "gave up after 10 minutes" },
    ]);
    // a stop on a detached run reaches the process the last daemon left
    expect(w.runs.stop("w1", "commit")).toBe(true);
    expect(w.killed).toEqual([100]);
    w.runs.stopWatching();
  });
});
