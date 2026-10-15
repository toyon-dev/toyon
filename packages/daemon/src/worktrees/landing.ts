// Whether a worktree is ready to land, decided after every finished turn: the repo's check runs
// in the worktree with its output on the transcript, and beside it the agent's quick model is
// asked for a commit message, whether the work reads as done, and one sentence on where it stands.
// The check decides; the model's doubt is kept as a sentence. The verdict is about the tree, not
// the turn: one that says the work can land stands through a new turn for as long as the tree is
// the one it saw, so a message that only asks, or sends the agent to work somewhere else, leaves
// the word where it was. A turn Toyon itself sent to fix a failure is the one kind that is sure
// to move the tree, so it takes the verdict with it as it starts, before a file has moved: a
// press on the word while the agent rebases would meet the same conflict, or tear the agent's
// rebase down. A tree that changes under it goes stale (service.gitStatus), and the
// same question can be asked again by hand, or the check alone re-run after a discard, which
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
import { answerPrompt, type LandInput, type LandVerdict, landPrompt } from "../agent/landing.ts";
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
/** how much of the next commit's diff summary the question carries */
const DIFF_CHARS = 2_000;
/** how much of the branch's committed summary rides along as context */
const CONTEXT_CHARS = 800;
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
    // the message a hook turned down is written again, told what the hook said
    d.hub.on("messageRefused", (id, said) =>
      fireAndForget(
        id,
        this.judge(id, `The commit-msg hook refused the last message, saying: ${said}`),
        "landing message after a refusal",
      ),
    );
    d.hub.on("agentStatus", (id, status) => {
      this.note(id, status);
      if (status === "working") this.turnStarts(id);
    });
    // the fix turn is sent to change the tree, so no verdict about it stands; the check after
    // the turn decides again
    d.hub.on("fixAsked", (id) => this.clear(id));
  }

  /** A new turn may be new work or none. A verdict that says the work can land stays: the
   * fingerprint retires it the moment a file moves, and the turn's end reads the tree again.
   * Anything else goes: a run in flight is about a tree that may be changing under it, and a
   * failed check is what the turn is most likely here to fix. */
  private turnStarts(worktreeId: string) {
    if (!this.d.state.worktree(worktreeId)?.landing?.ready) return this.clear(worktreeId);
    // the words being refreshed behind a standing verdict were about the turn before this one
    this.judging.delete(worktreeId);
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
    const held = await this.standing(wt);
    if (turn.end !== "done") {
      if (!held) this.clear(worktreeId);
      return;
    }
    if (!(await this.hasWork(wt))) {
      // nothing to judge and no message to write, but the turn still said something worth a line
      this.clear(worktreeId);
      return this.recapAnswer(wt, turn);
    }
    if (held) return this.reword(wt, turn, held);
    await this.run(wt, { at: turn.at, ask: true, quiet: false });
  }

  /** the verdict that says the work can land, when the tree is still the one it was written about */
  private async standing(wt: WorktreeInfo): Promise<Landing | undefined> {
    const l = wt.landing;
    if (!l?.ready) return undefined;
    return l.fingerprint === (await treeFingerprint(wt.path)) ? l : undefined;
  }

  /** A finished turn that left the tree as the verdict saw it. The check's answer was about these
   * same bytes, so it does not run again and the word never leaves the box. What the turn said can
   * still settle or raise a doubt, and the turn is owed its sentence, so the question is asked
   * again behind the standing verdict. The message stays the one already offered: the change it
   * names has not moved, and a subject that rewrote itself after every reply would not read as
   * the name of anything. */
  private async reword(wt: WorktreeInfo, turn: LastTurn, held: Landing) {
    if (!this.d.judge) return;
    const worktreeId = wt.id;
    const repo = this.d.state.requireRepo(wt.repoId);
    this.judging.set(worktreeId, turn.at);
    const started = Date.now();
    const prompt = landPrompt(await this.landInput(wt, repo));
    let verdict: LandVerdict | null = null;
    try {
      verdict = await this.d.judge(wt, prompt);
    } catch (e) {
      // the verdict as it stood is still true of the tree; only its words go unrefreshed
      log.warn(worktreeId, "landing verdict kept its words: the question went unanswered", e);
    }
    if (this.stopping || this.judging.get(worktreeId) !== turn.at) return;
    this.judging.delete(worktreeId);
    const row = this.d.state.worktree(worktreeId);
    // landed, discarded or checked again by hand while the question was out: not this verdict any more
    const now = row?.landing;
    if (!verdict || !row || !now?.ready || now.fingerprint !== held.fingerprint) return;
    // the doubt is rewritten from this answer, and the tree was just read as the one it saw
    const { why: _was, stale: _moved, ...rest } = now;
    const caveat = await this.sharedMigration(wt, repo);
    const doubt = [!verdict.ready && verdict.why ? verdict.why : "", caveat ?? ""].filter(Boolean).join(". ");
    const landing: Landing = { ...rest, at: turn.at, ...(doubt ? { why: doubt } : {}) };
    // a message is taken only where none was written, and with it goes the mark that one was owed
    if (!landing.subject && verdict.subject) {
      landing.subject = verdict.subject;
      if (verdict.body) landing.body = verdict.body;
      delete landing.unanswered;
    }
    if (row.lastTurn?.at === turn.at && verdict.recap) row.lastTurn.recap = { at: Date.now(), text: verdict.recap };
    log.info(
      worktreeId,
      `landing: tree unchanged, check not run again${doubt ? ", doubted" : ""}, ${Date.now() - started}ms`,
    );
    this.d.worktrees.setLanding(worktreeId, landing);
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

  /** What the question is asked with. The message is for the next commit, so the turns it reads
   * are the ones since the branch's last commit, or its last landing, after which the branch
   * restarted from main: the earlier turns describe work that is committed, and a model shown
   * them writes the subject for that work instead. The landing is read off the record's marks,
   * which every landing writes, the one git did by hand included. */
  private async landInput(wt: WorktreeInfo, repo: RepoInfo): Promise<LandInput> {
    const base = baseOf(repo);
    const entries = this.d.transcript(wt.id);
    const [diff, subjects, committedAt] = await Promise.all([
      diffSummary(wt.id, wt.path, base),
      recentSubjects(wt.path, base),
      lastOwnCommitAt(wt.id, wt.path, base),
    ]);
    const since = Math.max(committedAt, wt.lands?.at(-1)?.at ?? 0);
    return {
      title: wt.title,
      firstAsk: firstAskOf(entries),
      turns: turnsSince(entries, since),
      earlier: since > 0,
      diffStat: diff.own,
      committedStat: diff.committed,
      recentSubjects: subjects,
    };
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
    const pending: Landing = { at: opts.at, check: "pending", ready: false, fingerprint: "", ...kept };
    this.d.worktrees.setLanding(worktreeId, pending);
    // still the run being judged: a newer run, or a new turn since, means this answer is stale,
    // and a daemon on its way down means the answer is not one
    const live = () =>
      !this.stopping && this.judging.get(worktreeId) === opts.at && !!this.d.state.worktree(worktreeId);

    // The check and the question go out together: neither reads the other's answer, and a message
    // that waited on the check was missing for as long as the suite ran, and for good when it hung.
    // The check still decides the word; the message is on the row as soon as it is written, so a
    // commit can take it while the check is out, and it stays on a failed check for the commit
    // that fixes it. A run that goes stale under either answer writes nothing more.
    const command = repo.config.check?.trim();
    let checkDone = false;
    const checked = async (): Promise<Checked | undefined> => {
      if (!command) return { check: "none" };
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
      if (!(await run.admitted)) return undefined;
      if (!live()) {
        run.finish(null);
        return undefined;
      }
      const waited = Date.now() - started;
      let r: ExecResult;
      try {
        r = await this.d.check(worktreeId, command, { quiet: opts.quiet, timeoutMs: ceiling, onSpawn: run.spawned });
      } catch (e) {
        this.d.runs.drop(worktreeId, "check");
        throw e;
      }
      run.finish(r.exit);
      if (!live()) return undefined;
      const check = r.exit === 0 ? "pass" : "fail";
      let checkTail: string | undefined;
      if (r.exit === "timeout") {
        // the first line of the tail is what the placeholder says, so the ceiling goes first
        checkTail = [`gave up after ${describeDuration(ceiling)}`, tail(r.text)].filter(Boolean).join("\n");
      } else if (check === "fail") checkTail = tail(r.text) || `exit ${r.exit}`;
      // still live, so no turn has started since: the tree that passed is the tree as it stands
      else this.d.hub.emit("checkPassed", worktreeId);
      return { check, ran: r, waited, ...(checkTail ? { checkTail } : {}) };
    };
    const asked = async (): Promise<Asked | undefined> => {
      if (!opts.ask || !this.d.judge) return { verdict: null, unanswered: false };
      const prompt = landPrompt({ ...(await this.landInput(wt, repo)), ...(opts.note ? { note: opts.note } : {}) });
      let verdict: LandVerdict | null = null;
      let unanswered = false;
      try {
        verdict = await this.d.judge(wt, prompt);
      } catch (e) {
        if (!live()) return undefined;
        // the question was never put (the agent died, or would not open a session), which is not
        // the model declining: no message is made up, and the verdict says one is still owed, so
        // the box offers to ask again rather than a land word with no message behind it
        log.warn(worktreeId, "landing verdict unanswered", e);
        unanswered = true;
      }
      if (!live()) return undefined;
      // the check is still out: the message and the sentence go on the row now, under the
      // pending mark, rather than waiting on it
      if (!checkDone && verdict) {
        this.recapTurn(worktreeId, verdict);
        this.d.worktrees.setLanding(worktreeId, { ...pending, ...messageOf(verdict) });
      }
      return { verdict, unanswered };
    };
    const [checkResult, askResult] = await Promise.all([
      checked().finally(() => {
        checkDone = true;
      }),
      asked(),
    ]);
    if (!checkResult || !askResult || !live()) return;
    const { check, checkTail, ran, waited = 0 } = checkResult;
    const { verdict, unanswered } = askResult;

    const landing: Landing = {
      at: opts.at,
      check,
      ...(checkTail ? { checkTail } : {}),
      // the facts decide: the model's doubt rides beside the word as `why`, never in front of it
      ready: check !== "fail",
      ...kept,
      ...(verdict ? messageOf(verdict) : {}),
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
    if (verdict) this.recapTurn(worktreeId, verdict);
    // how long the word took to appear: the check and the side question are the two costs here,
    // and a wait for a slot behind the repo's other checks is named so a slow verdict has a reason
    log.info(
      worktreeId,
      `landing: check ${check}${landing.why ? ", doubted" : ""}${opts.ask ? "" : ", check only"}, ${Date.now() - started}ms${waited > 100 ? ` (waited ${waited}ms for a check slot)` : ""}`,
    );
    this.d.worktrees.setLanding(worktreeId, landing);
    // After the verdict is on the row, since the turn this starts is what takes the verdict down.
    // Not for a check killed at its ceiling or stopped, which names nothing to fix, and not for
    // the quiet one after a discard: the person just took work out, and an agent set going on
    // what is left could put it back.
    if (command && check === "fail" && ran && typeof ran.exit === "number" && !opts.quiet)
      this.d.hub.emit("checkFailed", worktreeId, { toolId: ran.toolId, command, text: ran.text });
  }

  /** the sentence goes on the turn it describes, when the answer carried one */
  private recapTurn(worktreeId: string, verdict: LandVerdict) {
    const record = this.d.state.worktree(worktreeId)?.lastTurn;
    if (record && verdict.recap) record.recap = { at: Date.now(), text: verdict.recap };
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

/** how the check ended, for the record: `none` with no command to run */
interface Checked {
  check: Landing["check"];
  checkTail?: string;
  ran?: ExecResult;
  /** how long the run stood in the repo's line for a slot before its check started */
  waited?: number;
}

/** what the question came back with: no verdict and not unanswered when nothing was asked */
interface Asked {
  verdict: LandVerdict | null;
  unanswered: boolean;
}

/** what the answer puts on the record: the message, and the doubt when the work did not read as done */
function messageOf(verdict: LandVerdict): Pick<Landing, "why" | "subject" | "body"> {
  return {
    ...(!verdict.ready && verdict.why ? { why: verdict.why } : {}),
    ...(verdict.subject ? { subject: verdict.subject } : {}),
    ...(verdict.body ? { body: verdict.body } : {}),
  };
}

function tail(text: string): string {
  const t = text.replace(/\s+$/, "");
  return t.length > TAIL_CHARS ? t.slice(-TAIL_CHARS) : t;
}

/** what the next commit would contain and what the branch committed already, as git's own
 * summaries: the uncommitted part against HEAD with the files git does not track yet, and the
 * committed part against the merge base. Two texts, since the prompt labels them differently. */
async function diffSummary(id: string, path: string, defaultBr: string): Promise<{ own: string; committed: string }> {
  const [base, dirty, untracked] = await Promise.all([
    git(path, "merge-base", "HEAD", defaultBr),
    git(path, "diff", "HEAD", "--stat"),
    git(path, "ls-files", "--others", "--exclude-standard"),
  ]);
  // a base git cannot place (not fetched yet, an unrelated history) leaves the branch's commits
  // out of the question, which then reads as the model's mistake: said here instead
  if (!base.ok) log.warn(id, `landing question: no merge base with ${defaultBr}: ${base.err.trim()}`);
  const committed = base.ok && base.out ? await git(path, "diff", "--stat", base.out, "HEAD") : null;
  const own = [dirty.out ? `Uncommitted:\n${dirty.out}` : "", untracked.out ? `New files:\n${untracked.out}` : ""]
    .filter(Boolean)
    .join("\n\n");
  return { own: cap(own, DIFF_CHARS), committed: cap(committed?.out ?? "", CONTEXT_CHARS) };
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

/** When the branch last took a commit of its own, in ms, or zero with none: the author time of
 * the newest non-merge commit over the base. Author time, since taking main in rebases the
 * branch and that rewrites the committer time; non-merge, since a merge sync on an adopted branch
 * makes a merge commit dated now. Zero with no commits of its own, so the turns since a landing
 * come from the transcript's landed mark instead. */
async function lastOwnCommitAt(id: string, path: string, defaultBr: string): Promise<number> {
  const r = await git(path, "log", "-1", "--no-merges", "--format=%at", `${defaultBr}..HEAD`);
  if (!r.ok) log.warn(id, `landing question: could not read the branch's commits over ${defaultBr}: ${r.err.trim()}`);
  const seconds = Number(r.out.trim());
  return r.ok && Number.isFinite(seconds) ? seconds * 1000 : 0;
}

async function recentSubjects(path: string, defaultBr: string): Promise<string[]> {
  const r = await git(path, "log", "--format=%s", "-n", "5", defaultBr);
  return r.ok ? r.out.split("\n").filter(Boolean) : [];
}
