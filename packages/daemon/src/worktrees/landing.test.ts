import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, Landing, LastTurn, RepoInfo, Timeouts, WorktreeInfo } from "@toyon/shared";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import type { LandVerdict } from "../agent/landing.ts";
import type { TranscriptEntry } from "../agent/transcript.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { GIT } from "../git/exec.ts";
import { treeFingerprint } from "../git/status.ts";
import { RunService } from "../runs/service.ts";
import { LandingService } from "./landing.ts";

// A real git worktree on a branch, a hub the test drives, and the check and the judge as stubs:
// what the verdict records is read off exactly what the tree and the answers were.

interface Opts {
  check?: string;
  /** how the check ends: its code, or `timeout` for one killed at the ceiling */
  exit?: number | string;
  output?: string;
  /** the settings' ceilings, when the test names one */
  timeouts?: Timeouts;
  /** the judge's answer; "none" leaves the service without a judge at all */
  verdict?: LandVerdict | null | "none";
  /** a judge of the test's own, for an answer that has to arrive late */
  judge?: (prompt: string) => Promise<LandVerdict | null>;
  /** the answer question's sentence for a turn with nothing to land; absent leaves it unasked */
  recap?: (prompt: string) => Promise<string | null>;
  /** what the worktree's agent has on its transcript */
  transcript?: TranscriptEntry[];
}

/** a transcript of one finished turn: the ask, the reply, and how it ended */
function answered(ask: string, reply: string): TranscriptEntry[] {
  const events: AgentEvent[] = [
    { type: "user-message", text: ask, ts: 1 },
    { type: "turn-start", ts: 2 },
    { type: "text-delta", text: reply },
    { type: "turn-end", stopReason: "end_turn", ts: 3 },
  ];
  return events.map((event, seq) => ({ seq, event }));
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
    config: {
      run: {},
      ...(opts.check ? { check: opts.check } : {}),
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
    },
    configFile: ".toyon/settings.json",
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
  /** whether each check was asked to keep its rows off the transcript unless it failed */
  const quiet: boolean[] = [];
  /** the ceiling each check was given */
  const ceilings: Array<number | undefined> = [];
  /** the check run's status on the record as each check was called */
  const runsSeen: Array<string | undefined> = [];
  const judged: string[] = [];
  /** the prompts the answer question was asked with */
  const recapped: string[] = [];
  const runs = new RunService({ state, hub });
  const service = new LandingService({
    state,
    hub,
    runs,
    worktrees: {
      setLanding: (id, landing) => {
        set.push(landing);
        const row = state.worktree(id);
        if (!row) return;
        if (landing) row.landing = landing;
        else delete row.landing;
      },
    },
    transcript: () => opts.transcript ?? [],
    ...(opts.recap
      ? {
          recap: async (_wt, prompt) => {
            recapped.push(prompt);
            return opts.recap?.(prompt) ?? null;
          },
        }
      : {}),
    check: async (_id, command, o) => {
      checks.push(command);
      quiet.push(!!o?.quiet);
      ceilings.push(o?.timeoutMs);
      // what the row says while the check is out: read here, since the stub is over at once
      runsSeen.push(state.worktree("w1")?.runs?.find((r) => r.kind === "check")?.status);
      o?.onSpawn?.(4242, () => {});
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
    // the verdict is written in the background; it has settled once something past the pending
    // mark was set (a clear counts: that is the answer for a tree with nothing to land)
    const done = () => set.some((l) => l === undefined || l.check !== "pending");
    for (let i = 0; wait && i < 50 && !done(); i++) await Bun.sleep(10);
  };
  const dirty = () => writeFileSync(join(wtPath, "feature.txt"), `${Date.now()}\n`);
  /** a run asked for by hand or a recheck has settled once a verdict past pending was set */
  const settled = async () => {
    const n = set.length;
    for (let i = 0; i < 50 && !set.slice(n).some((l) => l === undefined || l.check !== "pending"); i++)
      await Bun.sleep(10);
  };
  /** the answer question has settled once the turn carries its sentence, or a wait runs out */
  const recapSettled = async () => {
    for (let i = 0; i < 50 && !state.worktree("w1")?.lastTurn?.recap; i++) await Bun.sleep(10);
  };
  return {
    ...t,
    wtPath,
    state,
    hub,
    runs,
    ceilings,
    runsSeen,
    service,
    set,
    checks,
    quiet,
    judged,
    recapped,
    settle,
    settled,
    recapSettled,
    dirty,
    wt: () => state.worktree("w1"),
  };
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

  test("the box reads pending while the check runs, then the verdict with its message and the turn its sentence", async () => {
    w = world({
      check: "true",
      verdict: { ready: true, recap: "Adding the feature; it is in.", subject: "add the feature", body: "One file." },
    });
    w.dirty();
    await w.settle();
    expect(w.set[0]).toMatchObject({ at: 100, check: "pending", ready: false });
    expect(w.judged.length).toBe(1);
    expect(w.judged[0]).toContain("New files:\nfeature.txt");
    expect(w.wt()?.landing).toMatchObject({
      at: 100,
      check: "pass",
      ready: true,
      subject: "add the feature",
      body: "One file.",
    });
    expect(w.wt()?.landing?.why).toBeUndefined();
    expect(w.wt()?.landing?.fingerprint).toBe(await treeFingerprint(w.wtPath));
    expect(w.wt()?.lastTurn?.recap?.text).toBe("Adding the feature; it is in.");
  });

  test("the check runs under the settings' ceiling and stands on the row while it does", async () => {
    w = world({ check: "bun run check", timeouts: { check: "30m" }, verdict: { ready: true, subject: "s" } });
    w.dirty();
    await w.settle();
    expect(w.ceilings).toEqual([30 * 60_000]);
    expect(w.runsSeen).toEqual(["running"]);
    // over on its own: gone from the row, and the verdict is the word
    expect(w.wt()?.runs).toBeUndefined();
    expect(w.wt()?.landing?.check).toBe("pass");
  });

  test("a check killed at its ceiling is a failed verdict that says what it gave up after", async () => {
    w = world({ check: "bun run check", exit: "timeout", output: "tests 3/9\n", timeouts: { check: "30m" } });
    w.dirty();
    await w.settle();
    expect(w.judged).toEqual([]);
    expect(w.wt()?.landing).toMatchObject({ check: "fail", checkTail: "gave up after 30 minutes\ntests 3/9" });
    // the run stays on the row as terminated, with the same reason, until the next check
    expect(w.wt()?.runs).toEqual([
      expect.objectContaining({ kind: "check", status: "terminated", why: "gave up after 30 minutes" }),
    ]);
    // a new turn drops it with the verdict
    w.hub.emit("agentStatus", "w1", "working");
    expect(w.wt()?.runs).toBeUndefined();
    expect(w.wt()?.landing).toBeUndefined();
  });

  test("a verdict with no sentence leaves the turn to its facts", async () => {
    w = world({ verdict: { ready: true, subject: "add the feature" } });
    w.dirty();
    await w.settle();
    expect(w.wt()?.landing?.subject).toBe("add the feature");
    expect(w.wt()?.lastTurn?.recap).toBeUndefined();
  });

  test("the model's doubt is a sentence beside the word, not a gate; no check leaves the turn as the word", async () => {
    w = world({ verdict: { ready: false, why: "a question is open", subject: "add the feature" } });
    w.dirty();
    await w.settle();
    expect(w.checks).toEqual([]);
    expect(w.wt()?.landing).toMatchObject({
      check: "none",
      ready: true,
      why: "a question is open",
      subject: "add the feature",
    });
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
    expect(w.set.every((l) => l === undefined || l.check === "pending")).toBe(true);
  });

  test("a clean tree after a finished turn asks the answer question and the turn gets its sentence", async () => {
    w = world({
      recap: async () => "Asked whether a clean turn gets a recap; it does not, the row shows the facts.",
      transcript: answered("do we still recap with no files changed?", "No. The sentence rides with the verdict."),
    });
    await w.settle();
    await w.recapSettled();
    expect(w.set).toEqual([undefined]);
    expect(w.checks).toEqual([]);
    expect(w.judged).toEqual([]);
    expect(w.recapped.length).toBe(1);
    expect(w.recapped[0]).toContain("Task: feature");
    expect(w.recapped[0]).toContain("User asked: do we still recap with no files changed?");
    expect(w.recapped[0]).toContain("Agent ended with: No. The sentence rides with the verdict.");
    expect(w.recapped[0]).not.toContain("Diff summary");
    expect(w.wt()?.lastTurn?.recap?.text).toBe(
      "Asked whether a clean turn gets a recap; it does not, the row shows the facts.",
    );
    expect(w.wt()?.landing).toBeUndefined();
  });

  test("the answer question is not asked for a turn with no reply, nor for a stop that is not a finish", async () => {
    w = world({ recap: async () => "A sentence.", transcript: answered("hello", "   ") });
    await w.settle();
    await Bun.sleep(30);
    expect(w.recapped).toEqual([]);
    expect(w.wt()?.lastTurn?.recap).toBeUndefined();
    await w.settle("stopped", 200);
    await Bun.sleep(30);
    expect(w.recapped).toEqual([]);
  });

  test("an answer to an older turn is dropped once a new one has started", async () => {
    let release: (v: string) => void = () => {};
    const slow = new Promise<string>((r) => {
      release = r;
    });
    w = world({ recap: () => slow, transcript: answered("wdyt", "I'd do it.") });
    await w.settle("done", 100, false);
    for (let i = 0; i < 200 && !w.recapped.length; i++) await Bun.sleep(10);
    expect(w.recapped.length).toBe(1);
    w.hub.emit("agentStatus", "w1", "working");
    release("Asked for a view; the agent would do it.");
    await slow;
    await Bun.sleep(30);
    expect(w.wt()?.lastTurn?.recap).toBeUndefined();
  });

  test("judge() by hand runs the check and asks the question, for a tree with no verdict", async () => {
    w = world({ check: "bun run check", verdict: { ready: true, recap: "Feature in.", subject: "add the feature" } });
    w.dirty();
    w.wt()!.lastTurn = { at: 50, end: "stopped", facts: { turns: 1, edits: 1, toolErrors: 0 } };
    const settledAt = w.settled();
    await w.service.judge("w1");
    await settledAt;
    expect(w.checks).toEqual(["bun run check"]);
    expect(w.quiet).toEqual([false]);
    expect(w.judged.length).toBe(1);
    expect(w.wt()?.landing).toMatchObject({ check: "pass", ready: true, subject: "add the feature" });
    expect(w.wt()?.landing?.stale).toBeUndefined();
    // the sentence goes on the stopped turn, which had none
    expect(w.wt()?.lastTurn?.recap?.text).toBe("Feature in.");
  });

  test("judge() carries the note typed after the verb into the question", async () => {
    w = world({ check: "bun run check", verdict: { ready: true, subject: "add the feature" } });
    w.dirty();
    const settledAt = w.settled();
    await w.service.judge("w1", "  relates to the sync ticket  ");
    await settledAt;
    expect(w.judged).toHaveLength(1);
    expect(w.judged[0]).toContain("Note from the user for the commit message");
    expect(w.judged[0]).toContain("relates to the sync ticket");
    // a blank note is no note
    const again = w.settled();
    await w.service.judge("w1", "   ");
    await again;
    expect(w.judged[1]).not.toContain("Note from the user");
  });

  test("judge() is refused mid-turn and with nothing to land", async () => {
    w = world({ verdict: { ready: true, subject: "add the feature" } });
    await expect(w.service.judge("w1")).rejects.toThrow("nothing to check");
    w.dirty();
    w.hub.emit("agentStatus", "w1", "working");
    await expect(w.service.judge("w1")).rejects.toThrow("wait for the turn");
    w.hub.emit("agentStatus", "w1", "idle");
    const settledAt = w.settled();
    await w.service.judge("w1");
    await settledAt;
    expect(w.wt()?.landing?.subject).toBe("add the feature");
  });

  test("recheck() runs the check quietly and keeps the words; a row with no verdict is left alone", async () => {
    w = world({ check: "bun run check", verdict: { ready: true, subject: "a fresh message" } });
    w.dirty();
    w.service.recheck("w1");
    await Bun.sleep(30);
    expect(w.checks).toEqual([]);
    w.wt()!.landing = {
      at: 1,
      check: "pass",
      ready: true,
      why: "a question is open",
      subject: "add the feature",
      body: "One file.",
      fingerprint: "old",
      stale: true,
    };
    const settledAt = w.settled();
    w.service.recheck("w1");
    await settledAt;
    expect(w.checks).toEqual(["bun run check"]);
    expect(w.quiet).toEqual([true]);
    expect(w.judged).toEqual([]);
    expect(w.wt()?.landing).toEqual({
      at: expect.any(Number),
      check: "pass",
      ready: true,
      why: "a question is open",
      subject: "add the feature",
      body: "One file.",
      fingerprint: await treeFingerprint(w.wtPath),
    });
  });

  test("a question that was never answered is a verdict with no message, marked so the box asks again", async () => {
    let answers = 0;
    w = world({
      check: "bun run check",
      judge: async () =>
        answers++ === 0
          ? Promise.reject(new Error("ACP connection closed"))
          : { ready: true, subject: "add the feature" },
    });
    w.dirty();
    await w.settle();
    expect(w.checks).toEqual(["bun run check"]);
    expect(w.judged.length).toBe(1);
    // the check's word stands (it passed), the message does not, and the mark says one is owed
    expect(w.set.map((l) => l?.check)).toEqual(["pending", "pass"]);
    expect(w.wt()?.landing).toMatchObject({ check: "pass", ready: true, unanswered: true });
    expect(w.wt()?.landing?.subject).toBeUndefined();
    // the mark holds through a recheck, since only the check ran again
    w.service.recheck("w1");
    await w.settled();
    expect(w.wt()?.landing).toMatchObject({ check: "pass", unanswered: true });
    // asked again by hand, the answer clears it
    await w.service.judge("w1");
    await w.settled();
    expect(w.wt()?.landing).toMatchObject({ check: "pass", subject: "add the feature" });
    expect(w.wt()?.landing?.unanswered).toBeUndefined();
  });

  test("stop() mid-question leaves the verdict pending, and boot() finishes it", async () => {
    let fail!: (e: Error) => void;
    const dying = new Promise<LandVerdict | null>((_, reject) => {
      fail = reject;
    });
    let answers = 0;
    w = world({
      judge: () => (answers++ === 0 ? dying : Promise.resolve({ ready: true, subject: "add the feature" })),
    });
    w.dirty();
    await w.settle("done", 100, false);
    for (let i = 0; i < 50 && w.judged.length === 0; i++) await Bun.sleep(10);
    expect(w.wt()?.landing?.check).toBe("pending");
    // the daemon goes down under the question: the agent's death is not an answer
    w.service.stop();
    fail(new Error("ACP connection closed"));
    await Bun.sleep(30);
    expect(w.set.map((l) => l?.check)).toEqual(["pending"]);
    expect(w.wt()?.landing?.check).toBe("pending");
    // the next daemon finds the pending mark and runs the verdict from the top
    const next = new LandingService({
      state: w.state,
      hub: new Hub(),
      runs: w.runs,
      worktrees: {
        setLanding: (_id, landing) => {
          w!.set.push(landing);
          const row = w!.wt();
          if (row) row.landing = landing;
        },
      },
      transcript: () => [],
      check: async () => ({ exit: 0, text: "" }),
      judge: async () => ({ ready: true, subject: "add the feature" }),
    });
    const settledAt = w.settled();
    next.boot();
    await settledAt;
    expect(w.wt()?.landing).toMatchObject({ at: 100, check: "none", ready: true, subject: "add the feature" });
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
