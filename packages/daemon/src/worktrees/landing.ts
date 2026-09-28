// Whether a worktree is ready to land, decided after every finished turn: the repo's check runs
// in the worktree with its output on the transcript, and when it passes the agent's quick model is
// asked for a commit message, whether the work reads as done, and one sentence on where it stands.
// The check decides; the model's doubt is kept as a sentence. The verdict sits on the worktree
// record until a new turn starts; a tree that changes under it goes stale (service.gitStatus), and
// the same question can be asked again by hand, or the check alone re-run after a discard, which
// narrows the work without changing what the sentence and the message say about it. The sentence
// is the turn's recap and stays with the turn.

import {
  type AgentStatus,
  baseOf,
  canLand,
  describeDuration,
  keepsCopiesApart,
  type Landing,
  type LastTurn,
  type RepoInfo,
  timeoutFor,
  type WorktreeInfo,
} from "@toyon/shared";
import { answerPrompt, type LandVerdict, landPrompt } from "../agent/landing.ts";
import { firstAskOf, turnsSince } from "../agent/recap.ts";
import type { TranscriptEntry } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { ExecOpts, ExecResult } from "../exec/service.ts";
import { git } from "../git/exec.ts";
import { aheadBehind, committedFiles, statusFiles, treeFingerprint } from "../git/status.ts";
import type { RunService } from "../runs/service.ts";
import { migrationMatch } from "./backend.ts";
import type { WorktreeService } from "./service.ts";

export interface LandingServiceDeps {
  state: StateStore;
  hub: Hub;
  worktrees: Pick<WorktreeService, "setLanding">;
  /** the wait on the check, as the row carries it: how long, what it printed last, whether it was killed */
  runs: Pick<RunService, "begin" | "drop">;
  transcript: (worktreeId: string) => readonly TranscriptEntry[];
  /** run the repo's check in the worktree and report how it ended: its rows on the transcript,
   * or only when it fails with `quiet`; killed at `timeoutMs` */
  check: (worktreeId: string, command: string, opts?: ExecOpts) => Promise<ExecResult>;
  /** the verdict and message from the worktree's own agent, or null; without it the check decides */
  judge?: (wt: WorktreeInfo, prompt: string) => Promise<LandVerdict | null>;
  /** the sentence alone, for a finished turn with nothing to land; without it the line is the facts */
  recap?: (wt: WorktreeInfo, prompt: string) => Promise<string | null>;
}

/** how much of a failed check the placeholder gets: its last lines, where the verdict usually is */
const TAIL_CHARS = 400;
/** how much of the diff summary the question carries */
const DIFF_CHARS = 2_000;
/** how many of one repo's checks run at once. Four checks on one machine take longer than four
 * in a row, and every verdict is late instead of one; two keeps a second row moving while the
 * first is checked. Per repo, since a check's cost is the repo's, and the person waiting is
 * looking at one project. */
export const CHECK_SLOTS = 2;

/** one run of the verdict: what it is for, and whether the model is asked or only the check runs */
interface Run {
  /** the moment this run was asked for; a run stamped later supersedes it */
  at: number;
  /** ask the model for the message and the sentence, or keep the ones the verdict has */
  ask: boolean;
  /** the check's rows on the transcript only when it fails */
  quiet: boolean;
  /** what the person typed after the verb: a fact the commit message is asked to carry */
  note?: string | undefined;
}

export class LandingService {
  /** the run each worktree's verdict is being written by, so a slower answer to an older run is dropped */
  private judging = new Map<string, number>();
  /** worktrees whose agent is mid-turn: a verdict by hand waits for it to end */
  private busy = new Set<string>();
  /** the daemon is going down: a run in flight writes nothing more, and its pending mark is left
   * for the next daemon to finish, since the check it was killed under and the question its agent
   * died under are not answers */
  private stopping = false;

  constructor(private d: LandingServiceDeps) {
    d.hub.on("turnSettled", (id, turn) => fireAndForget(id, this.settle(id, turn), "landing verdict"));
    // a new turn is new work: whatever the last verdict said is about a tree that is changing
    d.hub.on("agentStatus", (id, status) => {
      this.note(id, status);
      if (status === "working") this.clear(id);
    });
  }

  private note(worktreeId: string, status: AgentStatus) {
    if (status === "working" || status === "waiting") this.busy.add(worktreeId);
    else this.busy.delete(worktreeId);
  }

  private clear(worktreeId: string) {
    this.judging.delete(worktreeId);
    // a check still running is about a tree that is changing: killed, since nothing will read its
    // answer, and a suite that takes twenty minutes is not left to run for nobody
    this.d.runs.drop(worktreeId, "check");
    this.d.worktrees.setLanding(worktreeId, undefined);
  }

  /** The verdicts the last daemon left mid-run: a record still pending was written when its run
   * started and never settled, because the process went down under the check or the question.
   * Each runs again from the top, the check and the question both. */
  boot() {
    for (const wt of this.d.state.worktrees) {
      if (wt.landing?.check !== "pending" || !canLand(wt)) continue;
      fireAndForget(wt.id, this.run(wt, { at: wt.landing.at, ask: true, quiet: false }), "landing verdict resumed");
    }
  }

  /** before the agents are closed: whatever is mid-run stays pending for boot() to finish */
  stop() {
    this.stopping = true;
  }

  private async settle(worktreeId: string, turn: LastTurn) {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || !canLand(wt)) return;
    if (turn.end !== "done") return this.clear(worktreeId);
    if (!(await this.hasWork(wt))) {
      // nothing to judge and no message to write, but the turn still said something worth a line
      this.clear(worktreeId);
      return this.recapAnswer(wt, turn);
    }
    await this.run(wt, { at: turn.at, ask: true, quiet: false });
  }

  /** The sentence for a turn that answered rather than changed anything. It is stamped only while
   * the turn it describes is still the last one: a new turn drops the question with the verdict's
   * own bookkeeping, and a slower answer to an older turn is left out. */
  private async recapAnswer(wt: WorktreeInfo, turn: LastTurn) {
    if (!this.d.recap) return;
    const worktreeId = wt.id;
    const entries = this.d.transcript(worktreeId);
    const turns = turnsSince(entries, 0);
    // a turn with no words, tools alone or an empty reply, has nothing to recap
    if (!turns.at(-1)?.reply.trim()) return;
    this.judging.set(worktreeId, turn.at);
    const started = Date.now();
    let text: string | null = null;
    try {
      text = await this.d.recap(wt, answerPrompt({ title: wt.title, firstAsk: firstAskOf(entries), turns }));
    } catch (e) {
      log.warn(worktreeId, "answer recap failed", e);
    }
    if (this.judging.get(worktreeId) !== turn.at) return;
    this.judging.delete(worktreeId);
    const record = this.d.state.worktree(worktreeId)?.lastTurn;
    if (!text || !record || record.at !== turn.at) return;
    record.recap = { at: Date.now(), text };
    log.info(worktreeId, `answer recap, ${Date.now() - started}ms`);
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** The verdict by hand: the same check and the same question, for a tree that moved under the
   * last one, a turn that stopped short of one, or a row that never had one. Refused while the
   * agent is mid-turn, since the tree is changing, and with nothing to land. The run goes on in the
   * background; the box reads pending from the first frame. A note typed after the verb goes to
   * the model with the question, so the message can say what the diff alone does not. */
  async judge(worktreeId: string, note?: string): Promise<void> {
    const wt = this.d.state.requireWorktree(worktreeId);
    if (!canLand(wt)) throw new UserError("nothing to land from here");
    if (this.busy.has(worktreeId)) throw new UserError("wait for the turn to end");
    if (!(await this.hasWork(wt))) throw new UserError("nothing to check: no changes here");
    const trimmed = note?.trim();
    fireAndForget(
      worktreeId,
      this.run(wt, { at: Date.now(), ask: true, quiet: false, ...(trimmed ? { note: trimmed } : {}) }),
      "landing verdict by hand",
    );
  }

  /** The check alone, after a discard narrowed the work: the sentence and the message still
   * describe what is left, so the model is not asked again, and a check that passes leaves no rows
   * on the transcript. A row with no verdict to refresh, or mid-turn, is left alone. */
  recheck(worktreeId: string): void {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt?.landing || !canLand(wt) || this.busy.has(worktreeId)) return;
    fireAndForget(worktreeId, this.run(wt, { at: Date.now(), ask: false, quiet: true }), "landing recheck");
  }

  private async hasWork(wt: WorktreeInfo): Promise<boolean> {
    const repo = this.d.state.requireRepo(wt.repoId);
    const files = await statusFiles(wt.path);
    if (files.length > 0) return true;
    const { ahead } = await aheadBehind(wt.path, baseOf(repo));
    return ahead > 0;
  }

  private async run(wt: WorktreeInfo, opts: Run) {
    const worktreeId = wt.id;
    const repo = this.d.state.requireRepo(wt.repoId);
    if (!(await this.hasWork(wt))) return this.clear(worktreeId);
    // what the verdict keeps when only the check runs again: the words, never the old check's result
    const held = opts.ask ? undefined : wt.landing;
    const kept = {
      ...(held?.why ? { why: held.why } : {}),
      ...(held?.subject ? { subject: held.subject } : {}),
      ...(held?.body ? { body: held.body } : {}),
      ...(held?.unanswered ? { unanswered: true as const } : {}),
    };

    this.judging.set(worktreeId, opts.at);
    const started = Date.now();
    // the box says the check is running rather than going back to its plain placeholder: the gap
    // between the agent's last word and the verdict is where a person is reading
    this.d.worktrees.setLanding(worktreeId, { at: opts.at, check: "pending", ready: false, fingerprint: "", ...kept });
    // still the run being judged: a newer run, or a new turn since, means this answer is stale,
    // and a daemon on its way down means the answer is not one
    const live = () =>
      !this.stopping && this.judging.get(worktreeId) === opts.at && !!this.d.state.worktree(worktreeId);

    let check: Landing["check"] = "none";
    let checkTail: string | undefined;
    let waited = 0;
    const command = repo.config.check?.trim();
    if (command) {
      const ceiling = timeoutFor(repo.config, "check");
      // a check from an earlier run of the verdict is still going: its answer is moot now
      this.d.runs.drop(worktreeId, "check");
      const run = this.d.runs.begin(worktreeId, "check", {
        timeoutMs: ceiling,
        slot: { key: repo.path, max: CHECK_SLOTS },
      });
      // queued behind the repo's other checks until a slot frees; one dropped meanwhile (a new
      // turn, a newer run) never spawns, and one admitted for a run that has since gone stale
      // gives its slot straight back
      if (!(await run.admitted)) return;
      if (!live()) return run.finish(null);
      waited = Date.now() - started;
      let r: ExecResult;
      try {
        r = await this.d.check(worktreeId, command, { quiet: opts.quiet, timeoutMs: ceiling, onSpawn: run.spawned });
      } catch (e) {
        this.d.runs.drop(worktreeId, "check");
        throw e;
      }
      run.finish(r.exit);
      if (!live()) return;
      check = r.exit === 0 ? "pass" : "fail";
      if (r.exit === "timeout") {
        // the first line of the tail is what the placeholder says, so the ceiling goes first
        checkTail = [`gave up after ${describeDuration(ceiling)}`, tail(r.text)].filter(Boolean).join("\n");
      } else if (check === "fail") checkTail = tail(r.text) || `exit ${r.exit}`;
    }

    let verdict: LandVerdict | null = null;
    let unanswered = false;
    if (opts.ask && check !== "fail" && this.d.judge) {
      const entries = this.d.transcript(worktreeId);
      const prompt = landPrompt({
        title: wt.title,
        firstAsk: firstAskOf(entries),
        turns: turnsSince(entries, 0),
        diffStat: await diffSummary(wt.path, baseOf(repo)),
        recentSubjects: await recentSubjects(wt.path, baseOf(repo)),
        ...(opts.note ? { note: opts.note } : {}),
      });
      try {
        verdict = await this.d.judge(wt, prompt);
      } catch (e) {
        if (!live()) return;
        // the question was never put (the agent died, or would not open a session), which is not
        // the model declining: no message is made up, and the verdict says one is still owed, so
        // the box offers to ask again rather than a land word with no message behind it
        log.warn(worktreeId, "landing verdict unanswered", e);
        unanswered = true;
      }
      if (!live()) return;
    }

    const landing: Landing = {
      at: opts.at,
      check,
      ...(checkTail ? { checkTail } : {}),
      // the facts decide: the model's doubt rides beside the word as `why`, never in front of it
      ready: check !== "fail",
      ...kept,
      ...(verdict && !verdict.ready && verdict.why ? { why: verdict.why } : {}),
      ...(verdict?.subject ? { subject: verdict.subject } : {}),
      ...(verdict?.body ? { body: verdict.body } : {}),
      ...(unanswered ? { unanswered: true as const } : {}),
      fingerprint: await treeFingerprint(wt.path),
    };
    // a migration on a branch whose settings keep no worktree apart lands on the database every
    // other worktree is using: said beside the word, where the doubt is read, never as a toast
    const caveat = await this.sharedMigration(wt, repo);
    if (caveat) landing.why = landing.why ? `${landing.why}. ${caveat}` : caveat;
    if (!live()) return;
    this.judging.delete(worktreeId);
    // the sentence goes on the turn it describes; setLanding saves and broadcasts the record with it
    const record = this.d.state.worktree(worktreeId)?.lastTurn;
    if (record && verdict?.recap) record.recap = { at: Date.now(), text: verdict.recap };
    // how long the word took to appear: the check and the side question are the two costs here,
    // and a wait for a slot behind the repo's other checks is named so a slow verdict has a reason
    log.info(
      worktreeId,
      `landing: check ${check}${landing.why ? ", doubted" : ""}${opts.ask ? "" : ", check only"}, ${Date.now() - started}ms${waited > 100 ? ` (waited ${waited}ms for a check slot)` : ""}`,
    );
    this.d.worktrees.setLanding(worktreeId, landing);
  }

  /** whether the work touches a migration while the tree names a shared database or stack and
   * the settings give no worktree its own */
  private async sharedMigration(wt: WorktreeInfo, repo: RepoInfo): Promise<string | undefined> {
    if (!repo.services || keepsCopiesApart(repo.config)) return undefined;
    const files = [...(await statusFiles(wt.path)), ...(await committedFiles(wt.path, baseOf(repo)))];
    if (!files.some((f) => migrationMatch(f.path))) return undefined;
    return "this changes migrations, and the worktrees share the database";
  }
}

function tail(text: string): string {
  const t = text.replace(/\s+$/, "");
  return t.length > TAIL_CHARS ? t.slice(-TAIL_CHARS) : t;
}

/** what would be committed and what already was, as git's own summary: the committed part
 * against the merge base, the uncommitted part against HEAD, and the files git does not track yet */
async function diffSummary(path: string, defaultBr: string): Promise<string> {
  const [base, dirty, untracked] = await Promise.all([
    git(path, "merge-base", "HEAD", defaultBr),
    git(path, "diff", "HEAD", "--stat"),
    git(path, "ls-files", "--others", "--exclude-standard"),
  ]);
  const committed = base.ok && base.out ? await git(path, "diff", "--stat", base.out, "HEAD") : null;
  const parts = [
    committed?.out ? `Committed on the branch:\n${committed.out}` : "",
    dirty.out ? `Uncommitted:\n${dirty.out}` : "",
    untracked.out ? `New files:\n${untracked.out}` : "",
  ].filter(Boolean);
  const text = parts.join("\n\n");
  return text.length > DIFF_CHARS ? `${text.slice(0, DIFF_CHARS)}\n...` : text;
}

async function recentSubjects(path: string, defaultBr: string): Promise<string[]> {
  const r = await git(path, "log", "--format=%s", "-n", "5", defaultBr);
  return r.ok ? r.out.split("\n").filter(Boolean) : [];
}
