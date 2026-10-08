import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, Landing, LastTurn, RepoInfo, Timeouts, WorktreeInfo } from "@toyon/shared";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { until } from "../../test/helpers/world.ts";
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
  /** more worktrees of the same repo, w2 and on, each on its own branch */
  extra?: number;
  /** a check that runs until the test ends it by worktree id, so several can be in flight */
  slow?: boolean;
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
  const extras: WorktreeInfo[] = [];
  for (let i = 2; i <= 1 + (opts.extra ?? 0); i++) {
    const path = join(t.repo, "..", `wt${i}`);
    sh(t.repo, GIT, "worktree", "add", "-q", "-b", `toyon/feature${i}`, path);
    extras.push({ ...wt, id: `w${i}`, path, branch: `toyon/feature${i}`, proxyPort: i, title: `feature ${i}` });
  }
  const state = new StateStore(t.paths, { repos: [repo], worktrees: [wt, ...extras], sessions: {} });
  const hub = new Hub();
  const set: Array<Landing | undefined> = [];
  const checks: string[] = [];
  /** whether each check was asked to keep its rows off the transcript unless it failed */
  const quiet: boolean[] = [];
  /** the worktrees whose check has started, in order, and how to end a slow one */
  const started: string[] = [];
  const ends = new Map<string, () => void>();
  /** the ceiling each check was given */
  const ceilings: Array<number | undefined> = [];
  /** the check run's status on the record as each check was called */
  const runsSeen: Array<string | undefined> = [];
  const judged: string[] = [];
  /** the checks whose failure was handed on for the agent to fix */
  const fixed: Array<{ toolId: string; command: string; text: string }> = [];
  /** the prompts the answer question was asked with */
  const recapped: string[] = [];
  hub.on("checkFailed", (_id, run) => fixed.push(run));
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
    check: async (id, command, o) => {
      checks.push(command);
      quiet.push(!!o?.quiet);
      ceilings.push(o?.timeoutMs);
      // what the row says while the check is out: read here, since the stub is over at once
      runsSeen.push(state.worktree("w1")?.runs?.find((r) => r.kind === "check")?.status);
      o?.onSpawn?.(4242, () => {});
      started.push(id);
      if (opts.slow) await new Promise<void>((end) => ends.set(id, end));
      return { exit: opts.exit ?? 0, text: opts.output ?? "", toolId: `check-${checks.length}` };
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
  const dirty = (id = "w1") => writeFileSync(join(state.requireWorktree(id).path, "feature.txt"), `${Date.now()}\n`);
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
  /** A verdict asked for on each tree, in this order in the repo's line. A run reads its tree
   * before it takes its place, so three asked for at once line up in whatever order git answers:
   * each is in line before the next is asked for. */
  const lineUp = async (ids: string[]) => {
    for (const id of ids) dirty(id);
    for (const id of ids) {
      await service.judge(id);
      await until(() => !!state.worktree(id)?.runs?.some((r) => r.kind === "check"));
    }
  };
  return {
    ...t,
    wtPath,
    lineUp,
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
    fixed,
    recapped,
    settle,
    settled,
    recapSettled,
    dirty,
    started,
    end: (id: string) => ends.get(id)?.(),
    wt: (id = "w1") => state.worktree(id),
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

  test("a check that passes says so on the hub, for what the tree built to be kept", async () => {
    w = world({ check: "true", verdict: null });
    const passed: string[] = [];
    w.hub.on("checkPassed", (id) => passed.push(id));
    w.dirty();
    await w.settle();
    expect(passed).toEqual(["w1"]);
  });

  test("a failed check is the verdict: not ready, the tail kept, and no question asked", async () => {
    w = world({ check: "bun run check", exit: 1, output: "src/App.tsx(3,1): error TS2322\n2 errors\n" });
    const passed: string[] = [];
    w.hub.on("checkPassed", (id) => passed.push(id));
    w.dirty();
    await w.settle();
    expect(w.checks).toEqual(["bun run check"]);
    expect(w.judged).toEqual([]);
    expect(passed).toEqual([]);
    expect(w.wt()?.landing).toMatchObject({
      check: "fail",
      ready: false,
      checkTail: "src/App.tsx(3,1): error TS2322\n2 errors",
    });
    // handed on once the verdict is on the row, for the turn that fixes it
    // with the row and what the check printed, which is what the agent is shown
    expect(w.fixed).toEqual([
      { toolId: "check-1", command: "bun run check", text: "src/App.tsx(3,1): error TS2322\n2 errors\n" },
    ]);
  });

  test("a check that fails after a discard is not handed to the agent", async () => {
    w = world({ check: "bun run check", exit: 1, output: "1 error\n" });
    w.dirty();
    w.wt()!.landing = { at: 1, check: "pass", ready: true, subject: "add the feature", fingerprint: "old" };
    const settledAt = w.settled();
    w.service.recheck("w1");
    await settledAt;
    expect(w.wt()?.landing?.check).toBe("fail");
    // the person just took work out: an agent set going on what is left could put it back
    expect(w.fixed).toEqual([]);
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

  test("a turn that ended asking or stopped keeps the verdict on the tree it saw, and clears it once the tree moved", async () => {
    w = world({ verdict: { ready: true, subject: "add the feature" } });
    w.dirty();
    await w.settle();
    const first = w.wt()?.landing;
    expect(first?.ready).toBe(true);
    w.set.length = 0;
    w.hub.emit("agentStatus", "w1", "working");
    await w.settle("asking", 200, false);
    await Bun.sleep(60);
    expect(w.set).toEqual([]);
    expect(w.wt()?.landing).toEqual(first);
    writeFileSync(join(w.wtPath, "more.txt"), "y\n");
    await w.settle("stopped", 300);
    expect(w.wt()?.landing).toBeUndefined();
  });

  test("a turn sent to fix a failure drops a verdict that says the work can land, before a file moves", async () => {
    w = world({ verdict: { ready: true, subject: "add the feature" } });
    w.dirty();
    await w.settle();
    expect(w.wt()?.landing?.ready).toBe(true);
    // the landing's rebase conflicted and the agent was sent to resolve it: the tree is still the
    // one the verdict saw, and the word would stand through the turn's start on that alone
    w.hub.emit("fixAsked", "w1");
    expect(w.wt()?.landing).toBeUndefined();
    w.hub.emit("agentStatus", "w1", "working");
    expect(w.wt()?.landing).toBeUndefined();
  });

  test("a new turn keeps a verdict that says the work can land, and one that leaves the tree alone runs no check", async () => {
    const answers: LandVerdict[] = [
      {
        ready: false,
        why: "a question is open",
        recap: "Added the feature.",
        subject: "add the feature",
        body: "One file.",
      },
      { ready: true, recap: "Answered the question; nothing changed.", subject: "another subject" },
    ];
    w = world({ check: "bun run check", judge: async () => answers.shift() ?? null });
    w.dirty();
    await w.settle();
    const first = w.wt()?.landing;
    expect(first).toMatchObject({ check: "pass", ready: true, why: "a question is open", subject: "add the feature" });
    w.set.length = 0;
    w.hub.emit("agentStatus", "w1", "working");
    expect(w.wt()?.landing).toEqual(first);
    w.hub.emit("agentStatus", "w1", "idle");
    await w.settle("done", 200);
    // the check's answer was about these bytes, and the box never went back to pending
    expect(w.checks).toEqual(["bun run check"]);
    expect(w.set.every((l) => l?.check === "pass")).toBe(true);
    // asked again for the doubt and the sentence; the message is the one already offered
    expect(w.judged.length).toBe(2);
    expect(w.wt()?.landing).toEqual({
      at: 200,
      check: "pass",
      ready: true,
      subject: "add the feature",
      body: "One file.",
      fingerprint: first?.fingerprint ?? "",
    });
    expect(w.wt()?.lastTurn?.recap?.text).toBe("Answered the question; nothing changed.");
  });

  test("a turn that moved the tree under a standing verdict gets the check and the message again", async () => {
    const answers: LandVerdict[] = [
      { ready: true, subject: "add the feature" },
      { ready: true, subject: "add the feature and more" },
    ];
    w = world({ check: "bun run check", judge: async () => answers.shift() ?? null });
    w.dirty();
    await w.settle();
    w.set.length = 0;
    w.hub.emit("agentStatus", "w1", "working");
    writeFileSync(join(w.wtPath, "more.txt"), "y\n");
    w.hub.emit("agentStatus", "w1", "idle");
    await w.settle("done", 200);
    expect(w.checks).toEqual(["bun run check", "bun run check"]);
    expect(w.set[0]).toMatchObject({ at: 200, check: "pending" });
    expect(w.wt()?.landing).toMatchObject({ at: 200, check: "pass", subject: "add the feature and more" });
    expect(w.wt()?.landing?.fingerprint).toBe(await treeFingerprint(w.wtPath));
  });

  test("words asked for behind a standing verdict are dropped once the work has landed or a new turn started", async () => {
    let release: (v: LandVerdict) => void = () => {};
    const slow = new Promise<LandVerdict>((r) => {
      release = r;
    });
    const answers: Array<Promise<LandVerdict> | LandVerdict> = [{ ready: true, subject: "add the feature" }, slow];
    w = world({ judge: async () => (await answers.shift()) ?? null });
    w.dirty();
    await w.settle();
    w.set.length = 0;
    await w.settle("done", 200, false);
    for (let i = 0; i < 200 && w.judged.length < 2; i++) await Bun.sleep(10);
    expect(w.judged.length).toBe(2);
    // the land took the verdict with it while the question was out
    delete w.wt()!.landing;
    release({ ready: false, why: "a question is open", recap: "late" });
    await slow;
    await Bun.sleep(30);
    expect(w.set).toEqual([]);
    expect(w.wt()?.landing).toBeUndefined();
    expect(w.wt()?.lastTurn?.recap).toBeUndefined();
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
    expect(w.recapped[0]).toContain(
      "Agent's last word, where the work stands now: No. The sentence rides with the verdict.",
    );
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

  test("one repo's checks run at most CHECK_SLOTS at once; the rest stand queued and start as one ends", async () => {
    w = world({ check: "bun run check", verdict: "none", extra: 2, slow: true });
    const ids = ["w1", "w2", "w3"];
    const status = (id: string) => w?.wt(id)?.runs?.find((r) => r.kind === "check")?.status;
    await w.lineUp(ids);
    await until(() => w?.started.length === 2);
    expect(w.started).toEqual(["w1", "w2"]);
    expect(ids.map(status)).toEqual(["running", "running", "queued"]);
    expect(ids.map((id) => w?.wt(id)?.landing?.check)).toEqual(["pending", "pending", "pending"]);
    w.end("w1");
    await until(() => w?.started.length === 3 && w.wt("w1")?.landing?.check === "pass");
    expect(w.started).toEqual(["w1", "w2", "w3"]);
    expect(status("w3")).toBe("running");
    w.end("w2");
    w.end("w3");
    for (let i = 0; i < 50 && ids.some((id) => w?.wt(id)?.landing?.check === "pending"); i++) await Bun.sleep(10);
    expect(ids.map((id) => w?.wt(id)?.landing?.check)).toEqual(["pass", "pass", "pass"]);
    expect(ids.map(status)).toEqual([undefined, undefined, undefined]);
  });

  test("a run that goes stale while it stands queued never spawns its check", async () => {
    w = world({ check: "bun run check", verdict: "none", extra: 2, slow: true });
    const ids = ["w1", "w2", "w3"];
    await w.lineUp(ids);
    await until(() => w?.started.length === 2);
    expect(w.started).toEqual(["w1", "w2"]);
    // a new turn on w3 while it stands in line: its verdict and its run are cleared, and the
    // check it was waiting to run is about a tree that is changing
    w.hub.emit("agentStatus", "w3", "working");
    expect(w.wt("w3")?.landing).toBeUndefined();
    expect(w.wt("w3")?.runs).toBeUndefined();
    w.end("w1");
    w.end("w2");
    for (let i = 0; i < 50 && ["w1", "w2"].some((id) => w?.wt(id)?.landing?.check === "pending"); i++)
      await Bun.sleep(10);
    expect(w.started).toEqual(["w1", "w2"]);
    expect(w.wt("w3")?.landing).toBeUndefined();
    expect(w.wt("w3")?.runs).toBeUndefined();
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
      check: async () => ({ exit: 0, text: "", toolId: "check-1" }),
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
