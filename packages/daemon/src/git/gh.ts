// GitHub through `gh`: the one host toyon talks to. Every call is bounded (a hung gh would hang a
// landing) and never prompts (a prompt nobody can see is a hang too). Absence of gh, or of a login,
// comes back as a failed result, never a throw: the caller decides whether that is a refusal or
// "a repo without PRs".

import type { MergeMethod, PrState } from "@toyon/shared";
import { type GitResult, NO_PROMPT, runLive } from "./exec.ts";

/** gh's own switches beside git's: no interactive prompts, no update nag on stderr */
const GH_ENV = { ...NO_PROMPT, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };

/** a PR create or merge holds the network for a few seconds; a minute means something is wrong */
const GH_TIMEOUT_MS = 60_000;

export function gh(args: string[], cwd: string, timeoutMs = GH_TIMEOUT_MS): Promise<GitResult> {
  return runLive("gh", args, cwd, { env: GH_ENV, signal: AbortSignal.timeout(timeoutMs) });
}

/** the methods the repo allows, as GitHub's settings have them */
export interface AllowedMethods {
  merge: boolean;
  squash: boolean;
  rebase: boolean;
}

/** the method a PR merges by: what the settings ask for when the repo allows it, else what the
 * repo allows, squash first (one commit per landing is what a team that opens PRs usually
 * wants). Null when nothing is allowed, which a ruleset can do. */
export function pickMethod(allowed: AllowedMethods, wanted?: MergeMethod): MergeMethod | null {
  if (wanted && allowed[wanted]) return wanted;
  for (const m of ["squash", "merge", "rebase"] as const) if (allowed[m]) return m;
  return null;
}

export async function ghMethod(repoPath: string, wanted?: MergeMethod): Promise<MergeMethod | null> {
  const r = await gh(["repo", "view", "--json", "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed"], repoPath);
  if (!r.ok) return wanted ?? "merge";
  const allowed = parseAllowed(r.out);
  return allowed ? pickMethod(allowed, wanted) : (wanted ?? "merge");
}

export function parseAllowed(json: string): AllowedMethods | null {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return {
      merge: o.mergeCommitAllowed === true,
      squash: o.squashMergeAllowed === true,
      rebase: o.rebaseMergeAllowed === true,
    };
  } catch {
    return null;
  }
}

/** the fields the box reads, in one call */
export const PR_VIEW_FIELDS = "number,url,state,mergedAt,reviewDecision,statusCheckRollup,mergeable,autoMergeRequest";

export async function viewPr(repoPath: string, number: number): Promise<PrState | null> {
  const r = await gh(["pr", "view", String(number), "--json", PR_VIEW_FIELDS], repoPath, 20_000);
  if (!r.ok || !r.out) return null;
  const parsed = parsePrView(r.out);
  return parsed ? { ...parsed, at: Date.now() } : null;
}

/** gh's JSON for one PR, folded to what the box says. Kept defensive: a field gh renames is a
 * missing word on the line, not a crash. */
export function parsePrView(json: string): Omit<PrState, "at"> | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof o.number !== "number" || typeof o.url !== "string") return null;
  const state = o.state === "MERGED" ? "merged" : o.state === "CLOSED" ? "closed" : "open";
  const review =
    o.reviewDecision === "APPROVED"
      ? "approved"
      : o.reviewDecision === "CHANGES_REQUESTED"
        ? "changes_requested"
        : o.reviewDecision === "REVIEW_REQUIRED"
          ? "review_required"
          : undefined;
  const checks = foldChecks(o.statusCheckRollup);
  const mergeable = o.mergeable === "MERGEABLE" ? true : o.mergeable === "CONFLICTING" ? false : undefined;
  const automerge = o.autoMergeRequest !== null && o.autoMergeRequest !== undefined;
  return {
    number: o.number,
    url: o.url,
    state,
    ...(review ? { review } : {}),
    ...(checks ? { checks } : {}),
    ...(mergeable !== undefined ? { mergeable } : {}),
    ...(automerge ? { automerge } : {}),
  };
}

/** GitHub's rollup mixes status contexts (`state`) and check runs (`status` + `conclusion`): one
 * failure is a fail, one still running is pending, otherwise pass; none is no word */
function foldChecks(rollup: unknown): PrState["checks"] | undefined {
  if (!Array.isArray(rollup) || rollup.length === 0) return undefined;
  let pending = false;
  for (const c of rollup as Record<string, unknown>[]) {
    const word = String(c.conclusion ?? c.state ?? "").toUpperCase();
    if (c.status && c.status !== "COMPLETED") {
      pending = true;
      continue;
    }
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(word))
      return "fail";
    if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", ""].includes(word)) pending = true;
  }
  return pending ? "pending" : "pass";
}

/** the PR number GitHub's URL ends in */
export function prNumberOf(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)(?:\D|$)/);
  return m ? Number(m[1]) : null;
}
