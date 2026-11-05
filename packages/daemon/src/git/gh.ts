// GitHub through `gh`: the one host toyon talks to. Every call is bounded (a hung gh would hang a
// landing) and never prompts (a prompt nobody can see is a hang too). Absence of gh, or of a login,
// comes back as a failed result, never a throw: the caller decides whether that is a refusal or
// "a repo without PRs".

import type { MergeMethod, PrComment, PrState } from "@toyon/shared";
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
export const PR_VIEW_FIELDS =
  "number,url,title,state,mergedAt,reviewDecision,statusCheckRollup,mergeable,autoMergeRequest,headRefOid";

export async function viewPr(repoPath: string, number: number): Promise<PrState | null> {
  return (await viewPrRef(repoPath, String(number)))?.pr ?? null;
}

/** a PR looked up by the branch it is the head of, with that head's commit beside it */
export interface FoundPr {
  pr: PrState;
  /** the commit the PR's head stood at, as GitHub has it; null when gh left it out */
  head: string | null;
}

/** The PR whose head is `branch`, as gh picks it: an open one first, else the newest, merged or
 * closed. The head commit comes with it so a merged PR can be told from one a branch of the same
 * name carried before: the row's own history reaches its head, a stranger's does not. */
export function findPr(repoPath: string, branch: string): Promise<FoundPr | null> {
  return viewPrRef(repoPath, branch);
}

/** one PR by either name gh takes, its number or its head branch */
async function viewPrRef(repoPath: string, ref: string): Promise<FoundPr | null> {
  const r = await gh(["pr", "view", ref, "--json", PR_VIEW_FIELDS], repoPath, 20_000);
  if (!r.ok || !r.out) return null;
  const parsed = parsePrView(r.out);
  if (!parsed) return null;
  const head = headOf(r.out);
  // Two more reads while the PR is open, side by side, since each is a gh process bounded at 20s
  // and a poll over several PRs runs them all. `pr view` says nothing about merge queues, and the
  // queue decides whether the land press merges or queues; a host that registers a deployment
  // instead of a status is asked for separately. A merged or closed PR is past both: the queue
  // is behind it and its preview is torn down.
  if (parsed.state === "open") {
    const [q, preview] = await Promise.all([
      viewQueue(repoPath, parsed.number),
      parsed.preview || !head ? null : viewDeploymentPreview(repoPath, head),
    ]);
    if (q?.queue) parsed.queue = true;
    if (q?.queued) parsed.queued = q.queued;
    if (preview) parsed.preview = preview;
  }
  return { pr: { ...parsed, at: Date.now() }, head };
}

/** the merge queue of the PR's base branch: whether the branch has one, and the PR's standing in
 * it when it is in. The node id rides along, since the enqueue mutation takes that, not the number. */
const QUEUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id isMergeQueueEnabled isInMergeQueue mergeQueueEntry { state } }
  }
}`;

export interface QueueFacts {
  /** the PR's node id, which the enqueue mutation takes */
  id: string;
  queue: boolean;
  queued?: PrState["queued"];
}

export async function viewQueue(repoPath: string, number: number): Promise<QueueFacts | null> {
  const r = await gh(
    [
      "api",
      "graphql",
      "-F",
      "owner={owner}",
      "-F",
      "name={repo}",
      "-F",
      `number=${number}`,
      "-f",
      `query=${QUEUE_QUERY}`,
    ],
    repoPath,
    20_000,
  );
  if (!r.ok || !r.out) return null;
  return parseQueue(r.out);
}

/** the queue facts out of gh's GraphQL answer; null when the PR is not in it or the JSON is not */
export function parseQueue(json: string): QueueFacts | null {
  let pr: Record<string, unknown> | null | undefined;
  try {
    const o = JSON.parse(json) as { data?: { repository?: { pullRequest?: Record<string, unknown> | null } } };
    pr = o.data?.repository?.pullRequest;
  } catch {
    return null;
  }
  if (!pr || typeof pr.id !== "string") return null;
  const entry = pr.mergeQueueEntry as Record<string, unknown> | null | undefined;
  const queued = pr.isInMergeQueue === true ? foldQueueState(entry?.state) : undefined;
  return { id: pr.id, queue: pr.isMergeQueueEnabled === true, ...(queued ? { queued } : {}) };
}

/** GitHub's entry states folded to what the line says. MERGEABLE and LOCKED are both the queue
 * merging it: its checks passed and it waits on the entries ahead, or the merge is under way. */
function foldQueueState(state: unknown): NonNullable<PrState["queued"]> {
  switch (state) {
    case "AWAITING_CHECKS":
      return "checking";
    case "MERGEABLE":
    case "LOCKED":
      return "merging";
    case "UNMERGEABLE":
      return "failed";
    default:
      return "waiting";
  }
}

const ENQUEUE_MUTATION = `mutation($id: ID!) {
  enqueuePullRequest(input: { pullRequestId: $id }) { mergeQueueEntry { id } }
}`;

/** Add the PR to its base branch's merge queue: what the button on GitHub presses. `gh pr merge`
 * on a queued branch turns to auto-merge instead, which a repo can forbid while still running a
 * queue; the mutation needs no auto-merge. */
export function enqueuePr(repoPath: string, id: string): Promise<GitResult> {
  return gh(["api", "graphql", "-f", `id=${id}`, "-f", `query=${ENQUEUE_MUTATION}`], repoPath);
}

function headOf(json: string): string | null {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return typeof o.headRefOid === "string" && o.headRefOid ? o.headRefOid : null;
  } catch {
    return null;
  }
}

/** the newest few deployments GitHub holds on one commit, with where each one is reachable */
const DEPLOYMENTS_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit {
      deployments(last: 10) { nodes { environment latestStatus { state environmentUrl } } }
    } }
  }
}`;

/** the URL of a deployment of the commit that is up, as the hosts that register one (Vercel,
 * Netlify, Cloudflare Pages, Render) record it; null when none, or when gh cannot say */
async function viewDeploymentPreview(repoPath: string, head: string): Promise<string | null> {
  // owner and name are gh's own placeholders, filled from the repo the cwd is in
  const r = await gh(
    [
      "api",
      "graphql",
      "-F",
      "owner={owner}",
      "-F",
      "name={repo}",
      "-f",
      `oid=${head}`,
      "-f",
      `query=${DEPLOYMENTS_QUERY}`,
    ],
    repoPath,
    20_000,
  );
  if (!r.ok || !r.out) return null;
  return parseDeployments(r.out);
}

/** the newest deployment that is up and has somewhere to open, out of gh's GraphQL answer */
export function parseDeployments(json: string): string | null {
  let nodes: unknown;
  try {
    const o = JSON.parse(json) as { data?: { repository?: { object?: { deployments?: { nodes?: unknown } } } } };
    nodes = o.data?.repository?.object?.deployments?.nodes;
  } catch {
    return null;
  }
  if (!Array.isArray(nodes)) return null;
  // GitHub lists them oldest first
  for (const d of [...(nodes as Record<string, unknown>[])].reverse()) {
    const st = d?.latestStatus as Record<string, unknown> | null | undefined;
    if (st?.state === "SUCCESS" && isPreviewUrl(st.environmentUrl)) return st.environmentUrl;
  }
  return null;
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
  const preview = state === "open" ? previewOf(o.statusCheckRollup) : undefined;
  return {
    number: o.number,
    url: o.url,
    state,
    ...(typeof o.title === "string" && o.title.trim() ? { title: o.title.trim() } : {}),
    ...(review ? { review } : {}),
    ...(checks ? { checks } : {}),
    ...(mergeable !== undefined ? { mergeable } : {}),
    ...(automerge ? { automerge } : {}),
    ...(preview ? { preview } : {}),
  };
}

/** the link of a status or check the host named a preview, once it has passed. Amplify's
 * "AWS Amplify Console Web Preview" and Netlify's "deploy-preview" both put the branch's URL
 * there; a CI job named for a preview points its link at its own log on github.com, which is not
 * one. The first that fits wins. */
function previewOf(rollup: unknown): string | undefined {
  if (!Array.isArray(rollup)) return undefined;
  for (const c of rollup as Record<string, unknown>[]) {
    const name = String(c.context ?? c.name ?? "");
    if (!/preview/i.test(name)) continue;
    const word = String(c.conclusion ?? c.state ?? "").toUpperCase();
    if (word !== "SUCCESS") continue;
    const url = c.targetUrl ?? c.detailsUrl;
    if (isPreviewUrl(url)) return url;
  }
  return undefined;
}

/** a link that opens the branch running somewhere, as against a log or a run on GitHub */
function isPreviewUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host !== "github.com" && !host.endsWith(".github.com");
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

/** Every line comment and review on the PR, oldest first; null when either read failed, so a
 * partial answer is never taken for the whole of what is there. Both through REST, one object a
 * line (`--jq '.[]'`), which reads the same whichever way gh joins the pages. */
export async function readPrComments(repoPath: string, number: number): Promise<PrComment[] | null> {
  const api = (what: string) =>
    gh(["api", `repos/{owner}/{repo}/pulls/${number}/${what}`, "--paginate", "--jq", ".[]"], repoPath, 20_000);
  const [lines, reviews] = await Promise.all([api("comments"), api("reviews")]);
  if (!lines.ok || !reviews.ok) return null;
  return [...parseLineComments(lines.out), ...parseReviews(reviews.out)].sort((a, b) => a.at - b.at);
}

/** the login gh is signed in as on `host`, or null when it cannot say. Asked of the PR's own
 * host: on a machine signed in to GitHub and to an Enterprise server the two are different people. */
export async function ghLogin(repoPath: string, host: string): Promise<string | null> {
  const r = await gh(["api", "user", "--hostname", host, "--jq", ".login"], repoPath, 20_000);
  const login = r.ok ? r.out.trim() : "";
  return login || null;
}

/** what `gh api ... --jq '.[]'` prints (one object a line), or a plain array, as objects */
function objectsOf(out: string): Record<string, unknown>[] {
  const text = out.trim();
  if (!text) return [];
  const lines = text.startsWith("[") ? [text] : text.split("\n");
  const objects: Record<string, unknown>[] = [];
  for (const line of lines) {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      // one bad line is one remark missed, not the rest of the PR's
      continue;
    }
    for (const o of Array.isArray(v) ? v : [v])
      if (o && typeof o === "object") objects.push(o as Record<string, unknown>);
  }
  return objects;
}

const loginOf = (user: unknown): string | null => {
  const login = (user as Record<string, unknown> | null | undefined)?.login;
  return typeof login === "string" && login ? login : null;
};

const timeOf = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

/** GitHub keeps what a browser's textarea sent, line ends and all */
const bodyOf = (v: unknown): string => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "");

const lineOf = (...vs: unknown[]): number | undefined => vs.find((v): v is number => typeof v === "number" && v > 0);

/** GitHub's line comments (`pulls/{n}/comments`), with an empty body skipped. A comment a later
 * push left behind has no `line`; its `original_line` is where it was written. */
export function parseLineComments(out: string): PrComment[] {
  const comments: PrComment[] = [];
  for (const o of objectsOf(out)) {
    const author = loginOf(o.user);
    const at = timeOf(o.created_at);
    const body = bodyOf(o.body);
    if (typeof o.id !== "number" || !author || at === null || !body || typeof o.html_url !== "string") continue;
    const line = lineOf(o.line, o.original_line);
    const start = lineOf(o.start_line, o.original_start_line);
    comments.push({
      id: `c${o.id}`,
      author,
      body,
      url: o.html_url,
      at,
      ...(typeof o.path === "string" && o.path ? { path: o.path } : {}),
      ...(line ? { line } : {}),
      ...(start && line && start < line ? { startLine: start } : {}),
      ...(typeof o.in_reply_to_id === "number" ? { replyTo: `c${o.in_reply_to_id}` } : {}),
    });
  }
  return comments;
}

/** GitHub's reviews (`pulls/{n}/reviews`). A review with no text of its own is the wrapper its
 * line comments came in, and is skipped, unless it approves or asks for changes, which is news
 * in itself. A pending review is its author's draft, and a dismissed one was taken back. */
export function parseReviews(out: string): PrComment[] {
  const reviews: PrComment[] = [];
  for (const o of objectsOf(out)) {
    const author = loginOf(o.user);
    const at = timeOf(o.submitted_at);
    const body = bodyOf(o.body);
    const review =
      o.state === "APPROVED"
        ? "approved"
        : o.state === "CHANGES_REQUESTED"
          ? "changes_requested"
          : o.state === "COMMENTED"
            ? "commented"
            : null;
    if (typeof o.id !== "number" || !author || at === null || !review || typeof o.html_url !== "string") continue;
    if (!body && review === "commented") continue;
    reviews.push({ id: `r${o.id}`, author, body, url: o.html_url, at, review });
  }
  return reviews;
}

/** the PR number GitHub's URL ends in */
export function prNumberOf(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)(?:\D|$)/);
  return m ? Number(m[1]) : null;
}
