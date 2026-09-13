import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Landing, LastTurn, RepoInfo, WorktreeInfo } from "@toyon/shared";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import type { LandVerdict } from "../agent/landing.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { GIT } from "../git/exec.ts";
import { treeFingerprint } from "../git/status.ts";
import { LandingService } from "./landing.ts";

// A real git worktree on a branch, a hub the test drives, and the check and the judge as stubs:
// what the verdict records is read off exactly what the tree and the answers were.

interface Opts {
  check?: string;
  exit?: number;
  output?: string;
  /** the judge's answer; "none" leaves the service without a judge at all */
  verdict?: LandVerdict | null | "none";
  /** a judge of the test's own, for an answer that has to arrive late */
  judge?: (prompt: string) => Promise<LandVerdict | null>;
}

function world(opts: Opts = {}) {
  const t = tmpRepo();
  const wtPath = join(t.repo, "..", "wt");
  sh(t.repo, GIT, "worktree", "add", "-q", "-b", "toyon/feature", wtPath);
  const repo: RepoInfo = {
    id: "r1",
    path: t.repo,
    name: "repo",
    defaultBranch: "main",
    config: { procs: {}, ...(opts.check ? { check: opts.check } : {}) },
    needsSetup: false,
  };
  const wt: WorktreeInfo = {
    id: "w1",
    repoId: "r1",
    path: wtPath,
    branch: "toyon/feature",
    kind: "worktree",
    proxyPort: 1,
    title: "feature",
    createdAt: 0,
  };
  const state = new StateStore(t.paths, { repos: [repo], worktrees: [wt], sessions: {} });
  const hub = new Hub();
  const set: Array<Landing | undefined> = [];
  const checks: string[] = [];
  const judged: string[] = [];
  new LandingService({
    state,
    hub,
    worktrees: {
      setLanding: (id, landing) => {
        set.push(landing);
        const row = state.worktree(id);
        if (!row) return;
        if (landing) row.landing = landing;
        else delete row.landing;
      },
    },
    transcript: () => [],
    check: async (_id, command) => {
      checks.push(command);
      return { exit: opts.exit ?? 0, text: opts.output ?? "" };
    },
    ...(opts.verdict === "none"
      ? {}
      : {
          judge: async (_wt, prompt) => {
            judged.push(prompt);
            if (opts.judge) return opts.judge(prompt);
            return opts.verdict === "none" ? null : (opts.verdict ?? null);
          },
        }),
  });
  const settle = async (end: LastTurn["end"] = "done", at = 100, wait = true) => {
    const turn: LastTurn = { at, end, facts: { turns: 1, edits: 1, toolErrors: 0 } };
    const row = state.worktree("w1");
    if (row) row.lastTurn = turn;
    hub.emit("turnSettled", "w1", turn);
    // the verdict is written in the background; it has settled once something was set
    for (let i = 0; wait && i < 50 && !set.length; i++) await Bun.sleep(10);
  };
  const dirty = () => writeFileSync(join(wtPath, "feature.txt"), `${Date.now()}\n`);
  return { ...t, wtPath, state, hub, set, checks, judged, settle, dirty, wt: () => state.worktree("w1") };
}

let w: ReturnType<typeof world> | undefined;
afterEach(() => {
  w?.cleanup();
  w = undefined;
});

describe("LandingService", () => {
  test("a clean tree with nothing ahead gets no verdict, and clears one it had", async () => {
    w = world();
    w.wt()!.landing = { at: 1, check: "none", ready: true, fingerprint: "x" };
    await w.settle();
    expect(w.set).toEqual([undefined]);
    expect(w.checks).toEqual([]);
  });

  test("a failed check is the verdict: not ready, the tail kept, and no question asked", async () => {
    w = world({ check: "bun run check", exit: 1, output: "src/App.tsx(3,1): error TS2322\n2 errors\n" });
    w.dirty();
    await w.settle();
    expect(w.checks).toEqual(["bun run check"]);
    expect(w.judged).toEqual([]);
    expect(w.wt()?.landing).toMatchObject({
      check: "fail",
      ready: false,
      checkTail: "src/App.tsx(3,1): error TS2322\n2 errors",
    });
  });

  test("a passing check and a ready answer make the verdict, message included", async () => {
    w = world({ check: "true", verdict: { ready: true, subject: "add the feature", body: "One file." } });
    w.dirty();
    await w.settle();
    expect(w.judged.length).toBe(1);
    expect(w.judged[0]).toContain("New files:\nfeature.txt");
    expect(w.wt()?.landing).toMatchObject({
      at: 100,
      check: "pass",
      ready: true,
      subject: "add the feature",
      body: "One file.",
    });
    expect(w.wt()?.landing?.fingerprint).toBe(await treeFingerprint(w.wtPath));
  });

  test("not ready keeps the reason; no check leaves the turn as the whole word", async () => {
    w = world({ verdict: { ready: false, why: "a question is open", subject: "add the feature" } });
    w.dirty();
    await w.settle();
    expect(w.checks).toEqual([]);
    expect(w.wt()?.landing).toMatchObject({ check: "none", ready: false, why: "a question is open" });
  });

  test("without a quick model the check alone decides", async () => {
    w = world({ check: "true", verdict: "none" });
    w.dirty();
    await w.settle();
    expect(w.wt()?.landing).toMatchObject({ check: "pass", ready: true });
    expect(w.wt()?.landing?.subject).toBeUndefined();
  });

  test("a turn that ended asking or stopped clears the verdict", async () => {
    w = world({ verdict: { ready: true, subject: "add the feature" } });
    w.dirty();
    await w.settle();
    expect(w.wt()?.landing?.ready).toBe(true);
    w.set.length = 0;
    await w.settle("asking", 200);
    expect(w.wt()?.landing).toBeUndefined();
  });

  test("a new turn starting clears it, and an answer to the old turn is dropped", async () => {
    let release: (v: LandVerdict) => void = () => {};
    const slow = new Promise<LandVerdict>((r) => {
      release = r;
    });
    w = world({ judge: () => slow });
    w.dirty();
    // the verdict is still being judged when the agent starts again
    await w.settle("done", 100, false);
    for (let i = 0; i < 200 && !w.judged.length; i++) await Bun.sleep(10);
    expect(w.judged.length).toBe(1);
    w.hub.emit("agentStatus", "w1", "working");
    release({ ready: true, subject: "add the feature" });
    await slow;
    await Bun.sleep(30);
    expect(w.wt()?.landing).toBeUndefined();
    expect(w.set.every((l) => l === undefined)).toBe(true);
  });

  test("the fingerprint moves with the tree", async () => {
    w = world();
    const before = await treeFingerprint(w.wtPath);
    w.dirty();
    const dirty = await treeFingerprint(w.wtPath);
    expect(dirty).not.toBe(before);
    sh(w.wtPath, GIT, "add", "-A");
    sh(w.wtPath, GIT, "commit", "-qm", "feature");
    expect(await treeFingerprint(w.wtPath)).not.toBe(dirty);
  });
});
