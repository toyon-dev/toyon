// Whether a worktree is ready to land, decided after every finished turn: the repo's check runs
// in the worktree with its output on the transcript, and when it passes the agent's quick model is
// asked for a commit message, whether the work reads as done, and one sentence on where it stands.
// The check decides; the model's doubt is kept as a sentence. The verdict sits on the worktree
// record until a new turn starts or the tree changes under it (service.gitStatus); the sentence is
// the turn's recap and stays with the turn.

import { canLand, type Landing, type LastTurn, type WorktreeInfo } from "@toyon/shared";
import { type LandVerdict, landPrompt } from "../agent/landing.ts";
import { firstAskOf, turnsSince } from "../agent/recap.ts";
import type { TranscriptEntry } from "../agent/transcript.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { ExecResult } from "../exec/service.ts";
import { git } from "../git/exec.ts";
import { aheadBehind, statusFiles, treeFingerprint } from "../git/status.ts";
import type { WorktreeService } from "./service.ts";

export interface LandingServiceDeps {
  state: StateStore;
  hub: Hub;
  worktrees: Pick<WorktreeService, "setLanding">;
  transcript: (worktreeId: string) => readonly TranscriptEntry[];
  /** run the repo's check in the worktree, its rows on the transcript, and report how it ended */
  check: (worktreeId: string, command: string) => Promise<ExecResult>;
  /** the verdict and message from the worktree's own agent, or null; without it the check decides */
  judge?: (wt: WorktreeInfo, prompt: string) => Promise<LandVerdict | null>;
}

/** how much of a failed check the placeholder gets: its last lines, where the verdict usually is */
const TAIL_CHARS = 400;
/** how much of the diff summary the question carries */
const DIFF_CHARS = 2_000;

export class LandingService {
  /** the turn each worktree's verdict is being written for, so a slower answer to an older turn is dropped */
  private judging = new Map<string, number>();

  constructor(private d: LandingServiceDeps) {
    d.hub.on("turnSettled", (id, turn) => fireAndForget(id, this.settle(id, turn), "landing verdict"));
    // a new turn is new work: whatever the last verdict said is about a tree that is changing
    d.hub.on("agentStatus", (id, status) => {
      if (status === "working") this.clear(id);
    });
  }

  private clear(worktreeId: string) {
    this.judging.delete(worktreeId);
    this.d.worktrees.setLanding(worktreeId, undefined);
  }

  private async settle(worktreeId: string, turn: LastTurn) {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || !canLand(wt)) return;
    if (turn.end !== "done") return this.clear(worktreeId);
    const repo = this.d.state.requireRepo(wt.repoId);
    const files = await statusFiles(wt.path);
    const { ahead } = await aheadBehind(wt.path, repo.defaultBranch);
    if (files.length === 0 && ahead === 0) return this.clear(worktreeId);

    this.judging.set(worktreeId, turn.at);
    const started = Date.now();
    // the box says the check is running rather than going back to its plain placeholder: the gap
    // between the agent's last word and the verdict is where a person is reading
    this.d.worktrees.setLanding(worktreeId, { at: turn.at, check: "pending", ready: false, fingerprint: "" });
    // still the turn being judged: a newer stop or a new turn since means this answer is stale
    const live = () =>
      this.judging.get(worktreeId) === turn.at && this.d.state.worktree(worktreeId)?.lastTurn?.at === turn.at;

    let check: Landing["check"] = "none";
    let checkTail: string | undefined;
    const command = repo.config.check?.trim();
    if (command) {
      const r = await this.d.check(worktreeId, command);
      if (!live()) return;
      check = r.exit === 0 ? "pass" : "fail";
      if (check === "fail") checkTail = tail(r.text) || `exit ${r.exit}`;
    }

    let verdict: LandVerdict | null = null;
    if (check !== "fail" && this.d.judge) {
      const entries = this.d.transcript(worktreeId);
      const prompt = landPrompt({
        title: wt.title,
        firstAsk: firstAskOf(entries),
        turns: turnsSince(entries, 0),
        diffStat: await diffSummary(wt.path, repo.defaultBranch),
        recentSubjects: await recentSubjects(wt.path, repo.defaultBranch),
      });
      try {
        verdict = await this.d.judge(wt, prompt);
      } catch (e) {
        log.warn(worktreeId, "landing verdict failed", e);
      }
      if (!live()) return;
    }

    const landing: Landing = {
      at: turn.at,
      check,
      ...(checkTail ? { checkTail } : {}),
      // the facts decide: the model's doubt rides beside the word as `why`, never in front of it
      ready: check !== "fail",
      ...(verdict && !verdict.ready && verdict.why ? { why: verdict.why } : {}),
      ...(verdict?.subject ? { subject: verdict.subject } : {}),
      ...(verdict?.body ? { body: verdict.body } : {}),
      fingerprint: await treeFingerprint(wt.path),
    };
    if (!live()) return;
    this.judging.delete(worktreeId);
    // the sentence goes on the turn it describes; setLanding saves and broadcasts the record with it
    const record = this.d.state.worktree(worktreeId)?.lastTurn;
    if (record && verdict?.recap) record.recap = { at: Date.now(), text: verdict.recap };
    // how long the word took to appear: the check and the side question are the two costs here
    log.info(worktreeId, `landing: check ${check}${landing.why ? ", doubted" : ""}, ${Date.now() - started}ms`);
    this.d.worktrees.setLanding(worktreeId, landing);
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
