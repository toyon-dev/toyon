// The op out on a row: land, sync, commit and pull, one at a time per row, with the agent's queue
// held while it runs. Every landing, whoever started it, comes in through `landing` and ends in
// `settle`, so a guard written once holds for the press, the poll and the landing a tree read
// finds. The worktree service builds this and keeps the names its callers use.

import {
  baseIsRemote,
  baseOf,
  canLand,
  DEFAULT_MERGE_METHOD,
  describeDuration,
  hasOwnBranch,
  isBusy,
  isMain,
  isProvisional,
  type LandedFacts,
  type Landing,
  type LandMark,
  type LandPolicy,
  landedNow,
  landPolicy,
  movedPastLand,
  notLandedWhy,
  type PrState,
  prPending,
  prTaken,
  type RepoInfo,
  type ShipOp,
  type Shipping,
  shipNoun,
  timeoutFor,
  type WorktreeInfo,
} from "@toyon/shared";
import type { Failure } from "../agent/prompt.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { commitOf, handLanding, type LandingRange, landingMark, landRef } from "../git/archive.ts";
import { git, RUN_CEILING_MS } from "../git/exec.ts";
import {
  commitWorktree,
  fetchBase,
  type LandWatch,
  landingCommit,
  landLocally,
  mergePr,
  openPr,
  pushBranch,
  pushLanding,
  requireLinear,
  type ShipResult,
  STEP_TIMEOUT_MS,
  splitMessage,
  squashMessage,
  stepRun,
  takeMainIn,
  UNWATCHED,
} from "../git/land.ts";
import { withFetchLock, withRepoLock } from "../git/lock.ts";
import { rangeSubjects } from "../git/log.ts";
import {
  aheadBehind,
  aheadOf,
  aheadUpstream,
  reaches,
  remoteHead,
  statusFiles,
  treeFingerprint,
} from "../git/status.ts";
import type { RunService } from "../runs/service.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import type { FixService } from "./fix.ts";
import type { ReadableWorktree, WorktreeServiceDeps } from "./service.ts";
import type { TreeCore, TreeState } from "./treeState.ts";
import type { Trunk } from "./trunk.ts";

/** how much of what a commit-msg hook printed the next message is written against: its last
 * lines, where the complaint is */
const REFUSAL_CHARS = 400;

/** a land that reads "nothing ahead" as "landed already" could not count, so it stops */
const uncounted = (base: string): ShipResult => ({
  ok: false,
  message: `could not count the commits ahead of ${base}; try again`,
});

/** a landing op's result as the service hands it on: `asked` when the agent was sent the turn that
 * fixes the failure, which the transcript then says in the line's place */
export type ShipOutcome = ShipResult & { asked?: true };

/** what a land op hands back: the result, `landed` when the work reached main and the row's word
 * is to be noted, and the mark it put on the record, so the word carries what landed. The mark
 * comes from the op and never from the record's last entry: a landing whose ref could not be kept
 * writes no mark, and the last entry would then be an earlier landing's. */
type Landed = {
  result: ShipResult;
  landed?: true;
  mark?: LandMark | undefined;
  /** the pull request the landing went through, for the row's word to link */
  url?: string | undefined;
  /** what kept the row's landed mark back after a landing that put the work on the base */
  held?: string | undefined;
  /** git did the landing and nothing of Toyon's ran, so no word of it goes on the transcript */
  unsaid?: true;
};

/** the row's command as a person would have typed it: a plain word as is, anything else quoted.
 * A commit message shows its subject; the row is a record of what ran, not a line to paste. */
const commandLine = (args: string[]) =>
  args.map((a) => (/^[\w./:=@,+-]+$/.test(a) ? a : JSON.stringify(a.split("\n", 1)[0]))).join(" ");

export interface ShipDeps {
  state: StateStore;
  hub: Hub;
  runtime: Pick<RuntimeRegistry, "agentFor" | "ensureAgent">;
  fix: Pick<FixService, "report">;
  runs: Pick<RunService, "begin">;
  tree: Pick<TreeState, "invalidate" | "invalidateAll" | "refresh">;
  trunk: Pick<Trunk, "pull" | "catchUp" | "noteFetch">;
  readable: (id: string) => ReadableWorktree | null;
  /** a press is a hand on the row: it goes to the top of the rail */
  stampPrompted: (id: string) => void;
  /** the row's HEAD moved under an op: its numbers are read again before the frame that says so */
  headMoved: (id: string) => Promise<void>;
  /** main moved under every row: all of them read again for the op's closing frame */
  recountAll: () => Promise<void>;
  watch?: WorktreeServiceDeps["watch"];
  fingerprint?: WorktreeServiceDeps["fingerprint"];
  message?: WorktreeServiceDeps["message"];
}

export class Ship {
  /** the landing ops out, by the row or trunk each runs on: what every frame carries as the
   * row's `shipping`, and what holds a chat sent meanwhile. In memory only: an op does not
   * outlive the daemon, and what git was left mid-way is git's to report on the next press. */
  private ops = new Map<string, Shipping>();
  /** worktrees whose sync from main was pressed mid-turn on a dirty tree: it runs when the turn
   * ends, and a press meanwhile takes it back. In memory, like the ops: a turn does not outlive
   * the daemon either. */
  private syncQueued = new Set<string>();
  /** the HEAD each clean, level worktree was last asked about a hand landing at: one reflog read per move */
  private handChecked = new Map<string, string>();
  /** worktrees whose hand landing found an op out and left the row to it: read again as that op
   * ends, since nothing else marks a row whose HEAD did not move */
  private handWaits = new Set<string>();

  constructor(private d: ShipDeps) {}

  /** a sync from main is waiting for the row's turn to end */
  syncWaiting(id: string): boolean {
    return this.syncQueued.has(id);
  }

  /** the row is on its way out, and what was waiting on it goes with it */
  forget(id: string): void {
    this.syncQueued.delete(id);
    this.handWaits.delete(id);
    this.handChecked.delete(id);
  }

  /** what GitHub last said about the worktree's PR, or none once new work has moved past it */
  setPr(worktreeId: string, pr: PrState | undefined) {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || (wt.pr === undefined && pr === undefined)) return;
    const pending = prPending(wt);
    if (pr) wt.pr = pr;
    else delete wt.pr;
    this.d.state.save();
    // work found on the base was left for this PR's merge to record. Closed or gone, it records
    // nothing, so the landing is one git did by hand: asked about again at the same HEAD, in the
    // read this frame sets off
    if (pending && !prPending(wt) && this.handChecked.delete(worktreeId)) this.d.tree.invalidate(worktreeId);
    this.d.hub.emit("worktreesChanged");
  }

  /** The landed mark, by the one rule (landedNow), from facts in hand or read now. Every path
   * that lands and every status read come through here, so a merge by hand, by GitHub, by the
   * poll and by the press converge on the same mark, and a row marked landed before landings
   * were recorded clears on its next read. */
  async refreshLanded(wt: WorktreeInfo, facts?: LandedFacts): Promise<void> {
    if (wt.kind === "main") return;
    const f = facts ?? (await this.landedFacts(wt));
    if (f) this.setLanded(wt, landedNow(wt, f));
  }

  /** The record after a landing, in one frame: the verdict goes and the landed mark comes
   * together. Sent one frame apart, the row between them carried work with no verdict, which the
   * box reads as a check to run, so its word flashed through "check" on the way to "archive". */
  private async settleLanded(wt: WorktreeInfo): Promise<string | undefined> {
    const repo = this.d.state.repo(wt.repoId);
    const f = wt.kind === "main" || !repo ? null : await this.landedFacts(wt);
    delete wt.landing;
    // the work is on the base by now, so a mark held back is news: the landed row says what held
    // it, and the log keeps it for a landing with no row (one git did by hand)
    let held: string | undefined;
    if (f && repo) {
      held = notLandedWhy(wt, f, baseOf(repo));
      if (held) {
        delete wt.landed;
        log.warn(wt.id, `landed, but not marked landed: ${held}`);
      } else wt.landed = true;
    }
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
    return held;
  }

  private async landedFacts(wt: WorktreeInfo): Promise<LandedFacts | null> {
    const repo = this.d.state.repo(wt.repoId);
    if (!repo) return null;
    try {
      const [head, ab] = await Promise.all([git(wt.path, "rev-parse", "HEAD"), aheadBehind(wt.path, baseOf(repo))]);
      if (!head.ok) return null;
      return { head: head.out, ahead: ab.ahead };
    } catch (e) {
      log.warn(wt.id, "could not read the tree for the landed mark", e);
      return null;
    }
  }

  /** written only on change, and absent rather than false, so a row that never landed carries
   * nothing */
  private setLanded(wt: WorktreeInfo, landed: boolean) {
    if (!!wt.landed === landed) return;
    if (landed) wt.landed = true;
    else delete wt.landed;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** the landing verdict for a worktree, or none: written after a turn, marked stale by a tree
   * that no longer matches it, and dropped by a new turn unless it says the work can land */
  private fingerprint(path: string): Promise<string> {
    return (this.d.fingerprint ?? treeFingerprint)(path);
  }

  setLanding(worktreeId: string, landing: Landing | undefined) {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || (wt.landing === undefined && landing === undefined)) return;
    if (landing) wt.landing = landing;
    else delete wt.landing;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  private landable(worktreeId: string, verb: string): { wt: WorktreeInfo; repo: RepoInfo } {
    const pair = this.d.state.requireWorktreeWithRepo(worktreeId);
    if (isMain(pair.wt)) throw new UserError(`${verb} from a worktree, not main`);
    if (!canLand(pair.wt)) throw new UserError(`${pair.wt.title} is a PR under review; it lands upstream, not here`);
    return pair;
  }

  /** what the newest work is called: the message typed for it, else the landing verdict's */
  private suggestion(wt: WorktreeInfo, typed?: string): string | undefined {
    const m = typed?.trim();
    if (m) return m;
    const s = wt.landing?.subject;
    if (!s) return undefined;
    return wt.landing?.body ? `${s}\n\n${wt.landing.body}` : s;
  }

  /** the message a land or a ship commits with (suggestion). None means the press cannot commit,
   * and the box to type one is named. */
  private commitMessage(wt: WorktreeInfo, typed?: string): string {
    const m = this.suggestion(wt, typed);
    if (m) return m;
    throw new UserError("no commit message yet: write one in the changes panel");
  }

  /** commit everything when there is anything, with the message a land or a ship was given */
  private async commitIfDirty(wt: WorktreeInfo, typed?: string): Promise<ShipResult | null> {
    if ((await statusFiles(wt.path)).length === 0) return null;
    return this.commitRecorded(wt, this.commitMessage(wt, typed));
  }

  /** the one commit, for land and the changes panel alike. A refusal (a hook that rejected the
   * commit, and what it said) goes on the transcript whole through the watch: the line the person
   * reads has room for a sentence, and the agent only learns of what is on the transcript. */
  private async commitRecorded(wt: WorktreeInfo, message: string): Promise<ShipResult> {
    const result = await commitWorktree(wt.path, message, this.landWatch(wt));
    if (result.ok) {
      await this.verdictSurvives(wt, { dropMessage: true });
      await this.d.headMoved(wt.id);
    }
    return result;
  }

  /** The watch a landing's steps run under: each step's name goes to the row's subscribers, so
   * the press says what it is on instead of spinning, and each git command runs through
   * ExecService.watch, so a hook's minutes read live on the chat and its refusal is whole for the
   * message that asks the agent to fix it. A command in the main checkout is named with its `-C`, since the row
   * sits on a worktree's chat. A worktree with no transcript yet runs the steps plain.
   *
   * A commit is the step with a suite in it (pre-commit), so it runs under the settings' commit
   * ceiling rather than the step's, and stands on the row as a run while it does: which hook git
   * is in, from git's own trace, and the last line the hook printed. */
  private landWatch(wt: WorktreeInfo): LandWatch {
    const repo = this.d.state.requireRepo(wt.repoId);
    return {
      step: (name) => this.step(wt.id, name),
      git: async (cwd, args) => {
        const where = cwd === wt.path ? "git" : `git -C ${cwd}`;
        const commit = args[0] === "commit";
        const ceiling = commit ? timeoutFor(repo.config, "commit") : STEP_TIMEOUT_MS;
        const handle = commit ? this.d.runs.begin(wt.id, "commit", { timeoutMs: ceiling, memory: true }) : null;
        // queued while memory is short, before the row for it opens on the chat: the hooks are
        // what the wait is for. Only a newer commit on the row takes this one's place.
        if (handle && !(await handle.admitted)) {
          const err = "a newer commit took its place";
          return { ok: false, out: "", err, exit: err, text: "" };
        }
        const run = (onText: (text: string) => void, signal?: AbortSignal) =>
          stepRun(cwd, args, onText, signal, {
            timeoutMs: ceiling,
            ...(handle ? { onSpawn: handle.spawned } : {}),
            // every step's hooks are watched, a push's as much as a commit's: the one that exits
            // non-zero is what refused the step, and only git's trace says which
            onHook: (hook) => handle?.stage(hook ? `${hook} hook` : undefined),
          });
        const watched = async () => {
          if (!this.d.watch) return run(() => {});
          const command = `${where} ${commandLine(args)}`;
          try {
            return { ...(await this.d.watch(wt.id, command, run)), command };
          } catch (e) {
            // no transcript to write to (the agent is not up yet): the step runs plain, and the line
            // under the box carries git's first words
            log.warn(wt.id, `landing step runs unwatched: ${e instanceof Error ? e.message : e}`);
            return run(() => {});
          }
        };
        const r = await watched();
        handle?.finish(r.exit);
        return r;
      },
    };
  }

  /** A commit by hand or a sync moves HEAD, and the next status read would mark the verdict stale
   * for it; but the check and the sentence were about these same bytes, so the verdict follows
   * with its fingerprint refreshed. After a commit the message goes: it is in git now, and the box
   * would otherwise keep offering what was just committed. After a sync it stays. */
  private async verdictSurvives(wt: WorktreeInfo, opts: { dropMessage: boolean }) {
    const l = wt.landing;
    if (!l || l.check === "pending") return;
    const { subject, body, unanswered, ...kept } = l;
    // the mark that a message was owed goes with the message: the commit by hand supplied one
    const message = opts.dropMessage
      ? {}
      : { ...(subject ? { subject } : {}), ...(body ? { body } : {}), ...(unanswered ? { unanswered } : {}) };
    this.setLanding(wt.id, { ...kept, ...message, fingerprint: await this.fingerprint(wt.path) });
  }

  /** The row lands the way the press lands it, for a landing git did without toyon (handLanding):
   * the range kept under a ref, the branch restarted from main so the next hand landing counts only
   * the commits after this one, and the verdict gone with the work it described. */
  private async landedByHand(wt: WorktreeInfo, mark: LandingRange) {
    const repo = this.d.state.requireRepo(wt.repoId);
    const base = baseOf(repo);
    log.info(wt.id, `landed on ${base} outside toyon: ${mark.base.slice(0, 7)}..${mark.tip.slice(0, 7)}`);
    // Outside the repo lock, alone among the routes: this runs inside a tree read, and under the
    // lock that read would wait behind another row's commit hook, with every recount behind it.
    // A hand landing writes no `landed` row, since nothing of Toyon's ran, but it is a landing
    // the siblings and the origin wait on all the same.
    await this.landing(wt, "auto", async () => ({
      result: { ok: true, message: `landed on ${base} outside toyon` },
      landed: true,
      unsaid: true,
      ...(await this.settle(wt, repo, mark)),
    }));
  }

  /** Every landing runs here, whoever started it: the press, the poll that heard GitHub merged
   * the PR, the read that found the work on the base already. It is the op out on the row, so a
   * second is refused and the agent's queue is held; the record's branch is the checkout's before
   * anything is measured; and a landing that put the work on the base says so once, on the
   * transcript and to the hub, after the op has let the row go. Nothing is awaited before the op
   * is out: the read that lands by hand looks for an op and calls this in the same tick. */
  private async landing(wt: WorktreeInfo, by: "press" | "auto", run: () => Promise<Landed>): Promise<Landed> {
    const out = await this.ship(wt.id, "land", by, async () => {
      await this.followBranch(wt);
      return run();
    });
    if (out.result.ok && out.landed) this.noteLanded(wt, out);
    return out;
  }

  /** The one press. Commit what is uncommitted, take main in (a rebase for toyon's own branch),
   * then the repo's route: merge here, merge here and push main, or push the branch and open a
   * PR. On a worktree whose PR is already open: push the work the PR is missing when there is
   * any, else merge the PR. Each step stops the rest when it fails, and the result says which: a
   * commit stands even when the rebase after it conflicts, since the work is safer committed. The
   * worktree stays, marked landed once the work is on main here, so the conversation can go on;
   * closing it is its own press. */
  async land(worktreeId: string, message?: string): Promise<{ result: ShipOutcome }> {
    const { wt, repo } = this.landable(worktreeId, "land");
    // inside the op, so the press is the one out on the row from its first tick
    const out = await this.landing(wt, "press", async () => {
      // a detached HEAD has no branch to land: merging the record's branch would report a landing
      // of nothing, and the restart after it would move HEAD off the commits it holds
      const on = await git(wt.path, "branch", "--show-current");
      if (on.ok && !on.out) throw new UserError(`${wt.title} is detached: check out a branch in it first`);
      const moved = await this.movedMidTurn(wt);
      if (moved) return { result: moved };
      return this.landOp(wt, repo, message);
    });
    return { result: this.fixShip(wt, out.result, baseOf(repo)) };
  }

  /** What a landing op's failure asks of the agent, after the op, whose hold on the queue is gone
   * by now. A hook that refused a commit or a push printed why on the transcript, and a rebase or
   * merge that stopped on conflicts names what to merge: both are the agent's to fix. A
   * commit-msg hook judged the message and not the tree, so the message is written again with
   * what the hook said, and the line says so. The op is not run again when the fix is in: the fix
   * changes what the press was about, and the check after the turn offers the word on the new
   * tree. */
  private fixShip(wt: WorktreeInfo, result: ShipResult, base: string): ShipOutcome {
    if (result.ok) return result;
    if (result.hook?.name === "commit-msg") {
      this.d.hub.emit("messageRefused", wt.id, result.hook.text.trim().slice(-REFUSAL_CHARS));
      return { ...result, message: "the commit-msg hook refused the message: another is being written" };
    }
    const { hook } = result;
    const failure: Failure | null = hook
      ? { kind: "hook", hook: hook.name, toolId: hook.toolId, command: hook.command, text: hook.text }
      : result.conflict
        ? {
            kind: "conflict",
            base,
            how: result.conflict,
            ...(result.step ? { step: result.step } : {}),
            ...(result.carried ? { carried: result.carried } : {}),
          }
        : null;
    return failure && this.d.fix.report(wt.id, failure) ? { ...result, asked: true } : result;
  }

  /** A land pressed mid-turn was offered on the verdict's tree, and the agent can write a file
   * between the frame that offered the word and the press: the commit would take bytes no check
   * saw. Refused here, where the tree is read under the op. At rest the tree moves only by the
   * person's own hand, and what they land is theirs to say. */
  private async movedMidTurn(wt: WorktreeInfo): Promise<ShipResult | null> {
    if (!isBusy(this.d.runtime.agentFor(wt.id)?.status)) return null;
    const l = wt.landing;
    if (!l || l.fingerprint === (await this.fingerprint(wt.path))) return null;
    return { ok: false, message: "the agent has changed files since the check: land once its turn ends" };
  }

  /** the word on a land that put the work on main, on the transcript the way a graft's marker is:
   * the row reads it back after a reload, where a frame to the sockets open at the time would not.
   * The siblings ride along for the row to offer, for as long as they are still rows. */
  private noteLanded(wt: WorktreeInfo, o: Landed) {
    if (!o.unsaid) {
      this.d.runtime.ensureAgent(wt).agent.note({
        type: "landed",
        message: o.result.message,
        ...(o.mark ? { mark: o.mark } : {}),
        ...(o.url ? { url: o.url } : {}),
        ...(o.held ? { held: o.held } : {}),
        ts: Date.now(),
      });
    }
    // after the row's own word: a worktree that handed this work off hears of it from here
    this.d.hub.emit("landed", wt.id, o.mark);
  }

  /** The record's branch is whatever the checkout is on. A hand switches branches in a worktree
   * the way it edits files there, and every count is read from HEAD already; a land that merged
   * the record's branch while HEAD was on another would report a landing of nothing and then
   * reset the branch with the work. A detached HEAD leaves the record as it was: there is no
   * branch to follow, and the land refuses it. Read here on every status and before a
   * landing, since a switch moves no file the watcher sees. */
  private async followBranch(wt: WorktreeInfo, current?: string): Promise<void> {
    if (wt.kind === "main") return;
    const branch = current ?? (await git(wt.path, "branch", "--show-current")).out;
    if (!branch || branch === wt.branch) return;
    log.info(wt.id, `on ${branch} now, not ${wt.branch}: the row follows the checkout`);
    wt.branch = branch;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** the landing op out on a row or a trunk, for its frame and for what is refused meanwhile */
  shippingOf(id: string): Shipping | undefined {
    return this.ops.get(id);
  }

  /** Run a landing op as the one out on the row: on every frame while it runs, with the agent's
   * queue held so a chat sent meanwhile waits rather than run under a rebase, and a second press
   * refused. The refusal is by id, so a found row and a trunk count too; a row with no agent (a
   * found worktree, main) has nothing to hold. A press is a hand on the row, so the row goes to
   * the top of the rail like a send's, at the press and whatever comes of it: a commit hook can
   * hold the op for minutes, and the row should not wait for it. Landed, it reads as the next
   * thing to archive; refused, it is the row whose failure is being fixed. An op nobody pressed
   * (a sync that waited for the turn, the trunk's pull) moves nothing. */
  private async ship<T>(id: string, op: ShipOp, by: "press" | "auto", run: () => Promise<T>): Promise<T> {
    const out = this.ops.get(id);
    if (out) throw new UserError(`${shipNoun(out.op)} is already running here`);
    // held before the frame says so: a send that reads the frame must find the queue held
    const release = this.d.runtime.agentFor(id)?.hold();
    this.ops.set(id, { op });
    // on the op's first frame, with the word it shows
    if (by === "press") this.d.stampPrompted(id);
    this.d.hub.emit("worktreesChanged");
    // an op out longer than a git call may run is waiting on the repo lock, the fetch lock or a
    // turn, and the row shows only the shining word: the log names the wait every ceiling
    const started = Date.now();
    const watchdog = setInterval(() => {
      const step = this.ops.get(id)?.step;
      const at = step ? ` at "${step}"` : "";
      log.warn(id, `${shipNoun(op)} still running after ${describeDuration(Date.now() - started)}${at}`);
    }, RUN_CEILING_MS);
    watchdog.unref?.();
    try {
      return await run();
    } finally {
      clearInterval(watchdog);
      this.ops.delete(id);
      release?.();
      // a landing by hand that left the row to this op is asked about again in the read this
      // frame sets off
      if (this.handWaits.delete(id)) this.d.tree.invalidate(id);
      this.d.hub.emit("worktreesChanged");
      // a sync that waited for the turn and then for this op runs now, while the tree is still
      if (!isBusy(this.d.runtime.agentFor(id)?.status)) this.syncAfterTurn(id);
    }
  }

  /** the op moved on: its frame says so, for whoever is waiting on it */
  private step(id: string, name: string) {
    const out = this.ops.get(id);
    if (!out || out.step === name) return;
    out.step = name;
    this.d.hub.emit("worktreesChanged");
  }

  /** The message a land commits with when none was typed and the verdict carries none: the
   * question went unanswered when the verdict was written, so it is asked again here, alone and
   * inside the op. The check's answer about this tree stands, and a press sent back through it
   * would run the suite again to get a sentence. Only with something to commit, since a land of
   * commits alone needs no message. */
  private async messageOwed(wt: WorktreeInfo, typed: string | undefined, w: LandWatch): Promise<string | undefined> {
    if (!this.d.message || this.suggestion(wt, typed)) return typed;
    if ((await statusFiles(wt.path)).length === 0) return typed;
    w.step("writing the message");
    return (await this.d.message(wt)) ?? typed;
  }

  private async landOp(wt: WorktreeInfo, repo: RepoInfo, typed?: string): Promise<Landed> {
    const policy = landPolicy(repo.config);
    const w = this.landWatch(wt);
    const message = await this.messageOwed(wt, typed, w);
    // what the newest commit's work is called: the message typed for it, else the verdict's.
    // Where the whole branch is named at once (a squash, a PR), squashMessage puts the branch's
    // earlier subjects under it.
    const suggested = this.suggestion(wt, message);
    if (policy.land === "pr") return this.landPr(wt, repo, policy, message, suggested, w);
    if (policy.land === "push") return this.landPush(wt, repo, policy, message, suggested, w);
    return this.landLocal(wt, repo, policy, message, suggested, w);
  }

  /** The PR route: the branch pushed and a PR opened on it, or, with one open, the work it is
   * missing pushed to it, else the PR merged. Nothing here touches the main checkout, and gh
   * holds the network for seconds, so the route runs outside the repo lock. */
  private async landPr(
    wt: WorktreeInfo,
    repo: RepoInfo,
    policy: LandPolicy,
    message: string | undefined,
    suggested: string | undefined,
    w: LandWatch,
  ): Promise<Landed> {
    const base = baseOf(repo);
    const own = hasOwnBranch(wt);
    // GitHub merged the PR while an op was out on the row, so the poll left the landing to this
    // press: it lands the merge, never a second PR of the same commit
    if (wt.pr?.state === "merged" && !prTaken(wt)) return this.prMergedOp(wt, undefined, w);
    // the branch is measured against origin's main, fetched now: main here is not pulled on
    // this route and can trail origin by days
    const fetched = await this.fetchBase(wt, repo, w);
    if (!fetched.ok) return { result: fetched };
    if (wt.pr?.state === "open") {
      // work since the PR opened goes to the PR, never under it: a merge now would take the
      // PR as GitHub has it and strand what is here
      const dirty = (await statusFiles(wt.path)).length > 0;
      const missing = dirty || ((await aheadUpstream(wt.path, wt.branch)) ?? 0) > 0;
      if (!missing) {
        const result = await mergePr(wt.path, wt.pr.number, policy.merge, w);
        // queued rather than merged: the row says so now, not on the poll's next pass
        if (result.ok && result.queued) this.setPr(wt.id, { ...wt.pr, queue: true, queued: "waiting", at: Date.now() });
        return { result };
      }
      const committed = await this.commitIfDirty(wt, message);
      if (committed && !committed.ok) return { result: committed };
      // marked before each move: a read out across it answers for the tree before, and is dropped
      this.d.tree.invalidate(wt.id);
      const taken = await takeMainIn(wt.path, base, own, w);
      if (!taken.ok) return { result: taken };
      await this.d.headMoved(wt.id);
      this.d.tree.invalidate(wt.id);
      const pushed = await pushBranch(wt.path, wt.branch, own, w);
      if (!pushed.ok) return { result: pushed };
      await this.d.headMoved(wt.id);
      this.setLanding(wt.id, undefined);
      const did = committed ? "committed and pushed" : "pushed";
      // GitHub drops a PR from the merge queue when its head moves: the row says so now rather
      // than "in the merge queue" until the poll, and the land word comes back with it
      if (wt.pr.queued) {
        const { queued: _, ...left } = wt.pr;
        this.setPr(wt.id, { ...left, at: Date.now() });
        return {
          result: {
            ok: true,
            url: wt.pr.url,
            message: `${did}; PR #${wt.pr.number} has the new commits and left the merge queue: land it again once it is ready`,
          },
        };
      }
      return { result: { ok: true, url: wt.pr.url, message: `${did}; PR #${wt.pr.number} has the new commits` } };
    }
    const committed = await this.commitIfDirty(wt, message);
    if (committed && !committed.ok) return { result: committed };
    // read before the rebase: what the branch carried, in case the rebase finds it all on origin
    const mark = await landingMark(wt.path, base);
    this.d.tree.invalidate(wt.id);
    const taken = await takeMainIn(wt.path, base, own, w);
    if (!taken.ok) return { result: taken };
    await this.d.headMoved(wt.id);
    // the rebase dropped every commit: origin's main holds this work already, through a PR
    // merged where toyon did not see it. The row lands the way a merged PR lands it.
    const ahead = await aheadOf(wt.path, base);
    if (ahead === null) return { result: uncounted(base) };
    if (ahead === 0) {
      const landed = await this.prMergedOp(wt, mark, w);
      const on = `origin's ${repo.defaultBranch} has this work already`;
      return { ...landed, result: { ...landed.result, message: `${on}; ${landed.result.message}` } };
    }
    // the branch's earlier subjects go under the title only where GitHub will squash them away;
    // a PR merged by rebase or merge keeps its commits, and the message is the newest work's
    const named = !suggested
      ? undefined
      : splitMessage(
          policy.merge === "squash" ? await squashMessage(wt.path, base, suggested, !!message?.trim()) : suggested,
        );
    const result = await openPr(
      {
        worktreePath: wt.path,
        branch: wt.branch,
        defaultBr: repo.defaultBranch,
        base,
        subject: named?.subject,
        body: named?.body,
        automerge: policy.automerge,
        own,
        method: policy.merge,
      },
      w,
    );
    if (result.ok) {
      this.setLanding(wt.id, undefined);
      if (result.pr) this.setPr(wt.id, { ...result.pr, at: Date.now() });
    }
    return { result };
  }

  /** The merge route: the branch lands on main in this checkout, by the repo's method, under the
   * repo lock from the commit to the record, so main and the branch move as one. */
  private landLocal(
    wt: WorktreeInfo,
    repo: RepoInfo,
    policy: LandPolicy,
    message: string | undefined,
    suggested: string | undefined,
    w: LandWatch,
  ): Promise<Landed> {
    const base = baseOf(repo);
    const own = hasOwnBranch(wt);
    return withRepoLock(repo.path, async (): Promise<Landed> => {
      const committed = await this.commitIfDirty(wt, message);
      if (committed && !committed.ok) return { result: committed };
      const method = policy.merge ?? DEFAULT_MERGE_METHOD;
      const merged = own && method === "rebase" ? await requireLinear(wt.path, base) : null;
      if (merged) return { result: merged };
      const taken = await takeMainIn(wt.path, base, own, w);
      if (!taken.ok) return { result: taken };
      // read before the landing moves main and the branch restarts from it
      const mark = await landingMark(wt.path, base);
      const squash = method === "squash" ? await squashMessage(wt.path, base, suggested, !!message?.trim()) : "";
      const landed = await landLocally(wt.path, wt.branch, repo.path, repo.defaultBranch, method, squash, w);
      if (!landed.ok) return { result: landed };
      const settled = await this.settle(wt, repo, mark, { squash });
      // the row says what the press did, not where the work sits: "is on main" read as the press
      // having found it there and done nothing
      const did = committed ? "committed and merged" : "merged";
      return { result: { ...landed, message: `${did} into ${repo.defaultBranch}` }, landed: true, ...settled };
    });
  }

  /** The push route: the landing built in the worktree and pushed straight to main on origin, so
   * nothing about the main checkout can block it. The branch takes the base in, fetched now; the
   * repo's method makes the landing commit here (landingCommit), so the repo's hooks run on what
   * reaches main, in the worktree and with its environment; and that commit goes to origin's
   * main. Origin moving in between is met once, fetch, rebase, rebuild, push again; a second
   * rejection asks for another press. Nothing here holds the repo lock but the record and the
   * restart: the worktree and the network are all the route touches, as on the PR route. Main
   * here follows as the trunk's housekeeping, and its note says why when it cannot. */
  private async landPush(
    wt: WorktreeInfo,
    repo: RepoInfo,
    policy: LandPolicy,
    message: string | undefined,
    suggested: string | undefined,
    w: LandWatch,
  ): Promise<Landed> {
    const base = baseOf(repo);
    const own = hasOwnBranch(wt);
    const method = policy.merge ?? DEFAULT_MERGE_METHOD;
    const committed = await this.commitIfDirty(wt, message);
    if (committed && !committed.ok) return { result: committed };
    // read before the fetch, the rebase and the method rewrite the branch: the commits it carried,
    // kept under the landing's ref. One read stands for a second attempt, whose branch is by then
    // the first attempt's landing commit.
    const read = await landingMark(wt.path, base);
    if (!read) return { result: { ok: false, message: `nothing to land: no commits ahead of ${base}` } };
    let sha = "";
    // the rebase dropped every commit: origin's main holds this work already, pushed by a hand
    // toyon did not see. Nothing to build or push; the row lands on the record as it stands.
    let already = false;
    // the squash message main received, when the method is squash: what the mark says landed
    let squash = "";
    const merged = own && method === "rebase" ? await requireLinear(wt.path, base) : null;
    if (merged) return { result: merged };
    for (let attempt = 0; ; attempt++) {
      const fetched = await this.fetchBase(wt, repo, w);
      if (!fetched.ok) return { result: fetched };
      // marked before each move: a read out across it answers for the tree before, and is dropped
      this.d.tree.invalidate(wt.id);
      const taken = await takeMainIn(wt.path, base, own, w);
      if (!taken.ok) return { result: taken };
      await this.d.headMoved(wt.id);
      const ahead = await aheadOf(wt.path, base);
      if (ahead === null) return { result: uncounted(base) };
      if (ahead === 0) {
        already = true;
        sha = (await commitOf(wt.path, base)) ?? "";
        break;
      }
      squash = method === "squash" ? await squashMessage(wt.path, base, suggested, !!message?.trim()) : "";
      this.d.tree.invalidate(wt.id);
      const built = await landingCommit(wt.path, wt.branch, base, method, squash, own, w);
      await this.d.headMoved(wt.id);
      if (!built.ok || !built.sha) return { result: built };
      sha = built.sha;
      const pushed = await pushLanding(wt.path, sha, repo.defaultBranch, w);
      if (pushed.ok) break;
      if (!pushed.moved) return { result: pushed };
      if (attempt > 0) {
        return { result: { ok: false, message: `${base} moved twice while this landed; land again` } };
      }
    }
    // origin's main is the pushed commit now, and the remote-tracking ref should say so from the
    // push itself; a fetch refspec that covers less than the branch is caught by reading it back
    if ((await commitOf(wt.path, base)) !== sha) await this.fetchBase(wt, repo, w);
    const settled = await withRepoLock(repo.path, () => this.settle(wt, repo, read, { squash }));
    const followed = await this.d.trunk.catchUp(repo.id);
    const here = followed.ok
      ? `${repo.defaultBranch} here ${followed.moved ? "pulled it" : "has it"}`
      : `${repo.defaultBranch} here was left where it is: ${followed.message}`;
    const how = { merge: "merged into", squash: "squashed onto", rebase: "rebased onto" }[method];
    const did = already
      ? `origin's ${repo.defaultBranch} has this work already`
      : `${committed ? `committed and ${how}` : how} ${repo.defaultBranch} and pushed`;
    return { result: { ok: true, message: `${did}; ${here}` }, landed: true, ...settled };
  }

  /** The work is on the base: the one tail every route ends in. The range goes on the record
   * under its ref; the branch restarts from the base, unless it holds commits the landing did not
   * take (`stay`); every row is counted again, since the base moved under all of them and the
   * frame the landed mark pushes must not carry the old ahead; and the verdict goes as the mark
   * comes, in one frame. The caller holds the repo lock where its route has one. */
  private async settle(
    wt: WorktreeInfo,
    repo: RepoInfo,
    mark: LandingRange | null,
    opts: { pr?: PrState | undefined; squash?: string | undefined; stay?: boolean } = {},
  ): Promise<Pick<Landed, "mark" | "held">> {
    const noted = await this.noteLand(repo, wt, mark, opts);
    if (!opts.stay) await this.restartFromMain(wt, baseOf(repo));
    this.d.tree.invalidateAll();
    return { mark: noted, held: await this.settleLanded(wt) };
  }

  /** A landing onto the record, oldest first, with its tip kept under a ref: the branch restarts from
   * main after it, and a squash never puts these commits on main, yet an archived worktree's page
   * still lists them. The mark says what landed in one line each: a merged PR's title, since
   * GitHub lands the PR by its own method and under that name; the squash message's subject for
   * a squash (the range names the originals, which main never got); the range's own subjects
   * otherwise. Returns the mark it wrote, so the row's word carries it; nothing when the ref
   * could not be kept. */
  private async noteLand(
    repo: RepoInfo,
    wt: WorktreeInfo,
    mark: LandingRange | null,
    opts: { pr?: PrState | undefined; squash?: string | undefined } = {},
  ): Promise<LandMark | undefined> {
    if (!mark) return undefined;
    const n = wt.lands?.length ?? 0;
    const pinned = await git(repo.path, "update-ref", landRef(wt.id, n), mark.tip);
    if (!pinned.ok) {
      log.warn(wt.id, `could not keep the commits it landed: ${pinned.err}`);
      return undefined;
    }
    const noted: LandMark = {
      ...mark,
      at: Date.now(),
      ...(opts.pr ? { pr: opts.pr.number } : {}),
      subjects: await this.landedWhat(repo, wt, mark, opts),
    };
    wt.lands = [...(wt.lands ?? []), noted];
    this.d.state.save();
    return noted;
  }

  private async landedWhat(
    repo: RepoInfo,
    wt: WorktreeInfo,
    mark: LandingRange,
    opts: { pr?: PrState | undefined; squash?: string | undefined },
  ): Promise<string[]> {
    if (opts.pr?.title) return [opts.pr.title];
    const subject = opts.squash ? splitMessage(opts.squash).subject : "";
    if (subject) return [subject];
    const read = await rangeSubjects(repo.path, mark.base, mark.tip);
    // the ref was pinned in this repo a moment ago, so a read that fails is news worth a line
    if (!read) log.warn(wt.id, `could not read what it landed: ${mark.base.slice(0, 7)}..${mark.tip.slice(0, 7)}`);
    return read ?? [];
  }

  /** the tip alone, as a landing with nothing under it: what goes on the record when a merged PR
   * left no range to read (the base already had every commit, and the reflog names none) */
  private async tipMark(wt: WorktreeInfo): Promise<LandingRange | null> {
    const head = await git(wt.path, "rev-parse", "HEAD");
    return head.ok ? { base: head.out, tip: head.out } : null;
  }

  /** A branch toyon owns restarts from the base once its work is there: the next message here
   * builds on the base as it is, and the counts read zero rather than the commits a squash or a
   * rebase on GitHub left with different hashes. An adopted branch keeps its history. `--keep`,
   * since a PR merges while a person may be mid-edit here: an edit the reset would not touch
   * rides over onto the base, and one it would overwrite refuses the reset whole, leaving the
   * branch on its landed tip, which the row reads as landed all the same; the counts carry the
   * edit as work left over. */
  private async restartFromMain(wt: WorktreeInfo, base: string): Promise<void> {
    if (!hasOwnBranch(wt)) return;
    // marked before the move: a read out across it answers for the tree before, and is dropped
    this.d.tree.invalidate(wt.id);
    const r = await git(wt.path, "reset", "--keep", base);
    if (!r.ok) log.warn(wt.id, `could not restart ${wt.branch} from ${base}: ${r.err}`);
    // the counts for the moved head, said in the settle's frame with the landed mark: a frame of
    // its own here carried the landing on the record without the mark, which a row reads as new
    // work over a landed PR
    await this.d.tree.refresh(wt.id);
  }

  /** the base fetched before a land or a sync measures against it (fetchBase), with the fetch on
   * the trunk's record either way, since every count against origin is as true as it */
  private async fetchBase(wt: WorktreeInfo, repo: RepoInfo, w: LandWatch): Promise<ShipResult> {
    if (!baseIsRemote(repo)) return { ok: true, message: `${baseOf(repo)} here is the base` };
    const r = await withFetchLock(repo.path, () => fetchBase(wt.path, repo, w));
    this.d.trunk.noteFetch(repo.id, { ok: r.ok, err: r.message });
    return r;
  }

  /** GitHub merged the worktree's PR: that is the landing, wherever it was merged from. The record
   * takes it and the branch restarts from main whatever state main here is in; main follows
   * origin as the trunk's own housekeeping, and when it cannot (edits in its way, a fetch refused)
   * the trunk's note says why and main's own pull is the retry. The row never waits on main: the
   * work is on origin, which is what the PR route measures against. `carried` is the range the
   * branch held before a rebase onto origin dropped it, when the press found the work on origin
   * already; read here otherwise. The poll runs unwatched; a press names its steps.
   *
   * `prMerged` is the poll's own entry: with nobody pressing, its landing is still shown on the
   * row the way a press is, and it is left to the press when one is out, since that press lands
   * the merged PR itself. */
  async prMerged(worktreeId: string): Promise<ShipResult> {
    const wt = this.d.state.worktree(worktreeId);
    // removed while GitHub was answering
    if (!wt) return { ok: false, message: "that worktree is gone" };
    const pr = wt.pr ? `PR #${wt.pr.number}` : "the PR";
    const out = this.ops.get(worktreeId);
    // said each time the poll comes round: nobody pressed this, so the log is the one place a
    // landing that waits on an op that never ends can be seen
    if (out) {
      const message = `${shipNoun(out.op)} is already running here`;
      log.info(worktreeId, `${pr} merged on GitHub; ${message}, landing waits`);
      return { ok: false, message };
    }
    // landed once: a second poll, or one that raced the first, records nothing more
    if (prTaken(wt)) return { ok: true, message: `${pr} merged; landed already` };
    log.info(worktreeId, `${pr} merged on GitHub; landing it`);
    const { result } = await this.landing(wt, "auto", () => this.prMergedOp(wt));
    if (result.ok) log.info(worktreeId, `landed: ${result.message}`);
    else log.warn(worktreeId, `landing failed: ${result.message}`);
    return result;
  }

  private async prMergedOp(wt: WorktreeInfo, carried?: LandingRange | null, w: LandWatch = UNWATCHED): Promise<Landed> {
    const repo = this.d.state.requireRepo(wt.repoId);
    const br = repo.defaultBranch;
    const base = baseOf(repo);
    // read before the base moves: a merge that kept the commits' hashes puts them on it, and
    // the range would then read as nothing to keep
    const read = carried === undefined ? await landingMark(wt.path, base) : carried;
    const pulled = await this.d.trunk.pull(repo.id, w);
    // after the pull, whose fetch is what puts a merge that kept the hashes on the base
    const past = await this.pastPr(wt, base);
    // Origin's main, fetched by the pull, whatever the checkout here could do with it. The branch
    // stays under commits the PR never had: the restart would take it off them.
    const settled = await withRepoLock(repo.path, async () =>
      this.settle(wt, repo, await this.prMark(wt, base, read, past), { pr: wt.pr, stay: !!past }),
    );
    const took = pulled.ok
      ? `${br} here ${pulled.moved ? "pulled it" : "has it"}`
      : `${br} here was left where it is: ${pulled.message}`;
    const left = past?.count
      ? `; ${past.count === 1 ? "a commit" : `${past.count} commits`} made since its last push stayed on the branch`
      : "";
    const message = `${wt.pr ? `PR #${wt.pr.number} merged; ${took}` : took}${left}`;
    return { result: { ok: true, message }, landed: true, url: wt.pr?.url, ...settled };
  }

  /** What a merged PR puts on the record, or nothing once a landing has taken it. A PR goes on
   * once, since the record is what says it was taken, and always: the trunk's own fetch often
   * moves the base before the poll sees the merge, and a merge that kept the hashes leaves no
   * range against it. Then the branch's own commits by its reflog, else the tip alone. A press
   * with no PR behind it records a range or nothing, so a second press over a landed row adds no
   * entry. What landed ends where the PR did: the commits past it are still the row's own work. */
  private async prMark(
    wt: WorktreeInfo,
    base: string,
    read: LandingRange | null,
    past: { tip?: string } | null,
  ): Promise<LandingRange | null> {
    if (prTaken(wt)) return null;
    const own = read ?? (await handLanding(wt.path, wt.branch, base, wt.lands?.at(-1)?.tip));
    const mark = own ?? (wt.pr ? await this.tipMark(wt) : null);
    return mark && past?.tip ? { ...mark, tip: past.tip } : mark;
  }

  /** The commits a merged PR never had: on HEAD, and in neither the base nor the PR's head, as
   * GitHub named it or as origin's copy of the branch stood at the last push or fetch. A commit
   * does not push, so one made after the PR opened is only here. Told by content as well as by
   * hash: a sync rebases the branch, and the copies it leaves of commits the PR has are not new
   * work. Null when there are none, which is every commit accounted for; `tip` is where the PR's
   * own work ends in the branch. With no word on where the PR stood, whatever the base lacks
   * counts, and a read git could not make counts too: a branch left in place can be landed again,
   * and one restarted over its commits cannot. */
  private async pastPr(wt: WorktreeInfo, base: string): Promise<{ count: number; tip?: string } | null> {
    if (!hasOwnBranch(wt)) return null;
    const named = [wt.pr?.head, await remoteHead(wt.path, wt.branch)];
    const known: string[] = [];
    // GitHub's head may be a commit this clone never fetched (a suggestion taken there)
    for (const sha of named) if (sha && !known.includes(sha) && (await commitOf(wt.path, sha))) known.push(sha);
    const read = await git(wt.path, "rev-list", "HEAD", "--not", base, ...known);
    if (!read.ok) {
      log.warn(wt.id, `could not read what ${wt.branch} holds past its PR: ${read.err}`);
      return { count: 0 };
    }
    // newest first, as rev-list walks
    let past = read.out.split("\n").filter(Boolean);
    for (const sha of known) {
      if (past.length === 0) break;
      const fresh = await git(wt.path, "rev-list", "--cherry-pick", "--right-only", `${sha}...HEAD`);
      if (!fresh.ok) continue;
      const kept = new Set(fresh.out.split("\n"));
      past = past.filter((c) => kept.has(c));
    }
    const oldest = past.at(-1);
    if (!oldest) return null;
    const tip = await git(wt.path, "rev-parse", "--verify", "--quiet", `${oldest}^`);
    return { count: past.length, ...(tip.ok && tip.out ? { tip: tip.out } : {}) };
  }

  /** take main into any row with a branch, a found worktree included: a rebase for toyon's own
   * branch, a merge for one it found or adopted. The one git write allowed without take-over,
   * because there both refuse a dirty tree before touching it and abort on a conflict, so the
   * directory is left as it was found in every case but success. A worktree toyon runs is dirty as
   * a rule (its agent never commits), so there the uncommitted work is carried across the sync.
   * `by` says whose it is: a press moves the row up the rail, at the press, even when the sync
   * itself waits for the turn; the run after the turn is nobody's hand and moves nothing. */
  async sync(worktreeId: string, by: "press" | "auto" = "press"): Promise<{ result: ShipOutcome; base: string }> {
    const r = this.d.readable(worktreeId);
    if (!r) throw new UserError("that worktree is gone");
    if (r.wt && isMain(r.wt)) throw new UserError("sync from a worktree, not main");
    if (r.wt && isProvisional(r.wt))
      throw new UserError("the new worktree already sits on main; it follows it on its own");
    if (!r.branch) throw new UserError(`${r.name} is detached: check out a branch in it first`);
    if (r.locked) throw new UserError(`${r.name} is held by another tool`);
    const repo = this.d.state.requireRepo(r.repoId);
    const own = r.wt ? hasOwnBranch(r.wt) : false;
    const carry = !!r.wt;
    // Carrying empties the tree for a moment, and a file tool writing into that gap is lost under
    // the work put back; a clean tree has no such gap. So under a turn the press is kept and runs
    // when the turn settles, which is what the person pressing it now wants of it anyway.
    const busy = isBusy(this.d.runtime.agentFor(worktreeId)?.status);
    if (carry && busy && (await statusFiles(r.path)).length > 0) {
      this.syncQueued.add(worktreeId);
      if (by === "press") this.d.stampPrompted(worktreeId);
      this.d.hub.emit("worktreesChanged");
      return { result: { ok: true, message: `${r.name} syncs from ${r.base} once the turn ends` }, base: r.base };
    }
    // a found worktree has no chat for the rows to go on
    const w = r.wt ? this.landWatch(r.wt) : UNWATCHED;
    const result = await this.ship(worktreeId, "sync-main", by, async () => {
      // the base as it is now, not as of the last fetch: outside the lock, since the fetch
      // holds the network for seconds and touches no checkout
      if (r.wt) {
        const fetched = await this.fetchBase(r.wt, repo, w);
        if (!fetched.ok) return fetched;
      }
      // marked before the move: a read out across it answers for the tree before, and is dropped
      this.d.tree.invalidate(worktreeId);
      const taken = await withRepoLock(repo.path, () => takeMainIn(r.path, r.base, own, w, carry));
      if (taken.ok) {
        await this.d.headMoved(worktreeId);
        // the same work over a newer base: the sentence and the message still describe it
        if (r.wt) await this.verdictSurvives(r.wt, { dropMessage: false });
      }
      return taken;
    });
    return { result: r.wt ? this.fixShip(r.wt, result, r.base) : result, base: r.base };
  }

  /** the sync waiting for the turn to end, taken back */
  unqueueSync(worktreeId: string): void {
    if (!this.syncQueued.delete(worktreeId)) return;
    this.d.hub.emit("worktreesChanged");
  }

  /** The turn a queued sync waited for is over. The queue is held here, inside the status
   * dispatch, so a message sent meanwhile waits for the sync rather than start a turn under the
   * carry; the op's own hold takes over once the sync is out, and the count lets this one go.
   * Nobody pressed this, so a failure is said on the chat the way a daemon's own is. */
  syncAfterTurn(worktreeId: string): void {
    if (!this.syncQueued.has(worktreeId)) return;
    // an op still out on the row (a commit or land pressed under the turn) would refuse a second:
    // the press keeps, and the op's own end runs it
    if (this.ops.has(worktreeId)) return;
    this.syncQueued.delete(worktreeId);
    const release = this.d.runtime.agentFor(worktreeId)?.hold();
    this.d.hub.emit("worktreesChanged");
    fireAndForget(
      worktreeId,
      (async () => {
        try {
          const { result } = await this.sync(worktreeId, "auto");
          if (!result.ok && !result.asked) this.d.hub.emit("failed", worktreeId, result.message);
        } catch (e) {
          this.d.hub.emit("failed", worktreeId, e instanceof Error ? e.message : String(e));
        } finally {
          release?.();
        }
      })(),
      "sync after the turn",
    );
  }

  /** Fast-forward main to its upstream, the trunk's own way (a fetch, then the fast-forward under
   * the lock, the fetch on the record); under a local base every worktree's `behind` moves with
   * it. Never a merge: a main that has diverged from origin is a decision for a terminal, not a
   * button. Uncommitted files on main are git's to judge, at the fast-forward: only one it would
   * overwrite refuses it, named. */
  async pull(worktreeId: string): Promise<ShipResult> {
    const wt = this.d.state.requireWorktree(worktreeId);
    if (!isMain(wt)) throw new UserError("pull on main; a worktree syncs from main instead");
    const repo = this.d.state.requireRepo(wt.repoId);
    // main has no chat for git's rows, so the pull's steps are named and nothing more
    const w: LandWatch = { step: (name) => this.step(worktreeId, name), git: UNWATCHED.git };
    return this.ship(worktreeId, "pull-main", "auto", async () => {
      const result = await this.d.trunk.pull(repo.id, w);
      // main moved under every row: the op's closing frame carries all of them read again
      if (result.ok && result.moved) await this.d.recountAll();
      return result;
    });
  }

  async commit(worktreeId: string, message: string): Promise<ShipOutcome> {
    const wt = this.d.state.requireWorktree(worktreeId);
    const m = message.trim();
    if (!m) throw new UserError("commit message required");
    const base = baseOf(this.d.state.requireRepo(wt.repoId));
    return this.fixShip(wt, await this.ship(wt.id, "commit", "press", () => this.commitRecorded(wt, m)), base);
  }

  /** What the landing record takes from a tree read the owner accepted: the branch the checkout
   * is on, a landing git did without toyon, the PR and landed marks (the one place the `landed`
   * badge is cleared: new work after a merge means it is no longer landed), and the verdict's
   * fingerprint. True when they moved the tree, so the owner reads it once more before anything
   * is published. The owner calls this only with no op out on the row. */
  async afterRead(r: ReadableWorktree, wt: WorktreeInfo, core: TreeCore): Promise<boolean> {
    const isMain = wt.kind === "main";
    if (core.branch) await this.followBranch(wt, core.branch);
    const { files, head } = core;
    const ahead = core.ahead ?? 0;
    // a landing git did without toyon: the branch is clean and level with the base and has
    // commits of its own since its last landing. Asked once per HEAD, and before the landed
    // mark is read, since a second hand landing over a first leaves the row landed by the rule
    // while its range is still unrecorded; the land press and a PR merge mark their own.
    if (
      !isMain &&
      hasOwnBranch(wt) &&
      files.length === 0 &&
      ahead === 0 &&
      head &&
      this.handChecked.get(wt.id) !== head
    ) {
      this.handChecked.set(wt.id, head);
      const mark = await handLanding(r.path, wt.branch, r.base, wt.lands?.at(-1)?.tip);
      if (mark) {
        // The work is on the base while the row's PR is on no landing yet: a merge that kept
        // the hashes, fetched before any word of it from GitHub. The landing is the PR's, on the
        // record once and under its number; one by hand here would leave the PR to go on a
        // second time. GitHub calls a PR merged once its head is on the base, and this history
        // is level with the base, so a head found in it is the merge, known without asking.
        const merged =
          prPending(wt) && (wt.pr?.state === "merged" || (!!wt.pr?.head && (await reaches(r.path, wt.pr.head))));
        // an op that started under this read owns the row until it ends: this HEAD is asked
        // about again in the read its closing frame sets off
        const out = this.ops.get(wt.id);
        if (out) {
          this.handChecked.delete(wt.id);
          this.handWaits.add(wt.id);
          log.info(
            wt.id,
            `landed on ${r.base} outside toyon; ${shipNoun(out.op)} is already running here, landing waits`,
          );
          return false;
        }
        // closed, taken or gone: under the reads above as well
        const pr = prPending(wt) ? wt.pr : undefined;
        if (!pr) {
          await this.landedByHand(wt, mark);
          return true;
        }
        if (merged) {
          // the queue is behind a merged PR, as it is on the record GitHub gives of one
          const { queue: _had, queued: _was, ...rest } = pr;
          if (pr.state !== "merged") this.setPr(wt.id, { ...rest, state: "merged" });
          // not waited for: the landing pulls main, over the network and under the repo lock,
          // and this read is one every recount queues behind
          fireAndForget(wt.id, this.prMerged(wt.id), "pr landing");
        } else {
          // GitHub never named the PR's head, or it holds commits this history lacks: only
          // GitHub can say, and is asked now, once for this HEAD
          log.info(wt.id, `the work is on ${r.base}; PR #${pr.number} lands it once GitHub says it merged`);
          this.d.hub.emit("prDue", wt.id);
        }
        // the PR's landing went out in that same tick, and the marks are its op's from here
        if (this.ops.has(wt.id)) return false;
      }
    }
    if (!isMain && head) {
      const facts = { head, ahead };
      // committed work past a merged PR is a new PR later; the old one is history. An edit
      // alone is not: it may be discarded, and the PR was taken either way.
      if (prTaken(wt) && movedPastLand(wt, facts)) this.setPr(wt.id, undefined);
      await this.refreshLanded(wt, facts);
    }
    // a verdict describes one tree: an edit since (by hand, by another tool) marks it stale, so
    // the composer keeps the sentence and the message but withholds the word until the check
    // runs again. A tree that comes back to what the verdict saw (an edit undone) clears the mark.
    const landing = wt.landing;
    if (landing && landing.check !== "pending") {
      const moved = landing.fingerprint !== (await this.fingerprint(r.path));
      // the verdict moved or went while the tree was being read: the next poll judges the new one
      if (wt.landing === landing && moved !== !!landing.stale) {
        const { stale: _was, ...rest } = landing;
        this.setLanding(wt.id, moved ? { ...rest, stale: true } : rest);
      }
    }
    return false;
  }
}
