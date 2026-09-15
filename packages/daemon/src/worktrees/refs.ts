// What the ref palette searches: local branches nobody has checked out, remote branches as of
// the last fetch, and the repo's open pull requests. A ref is not a row. The rail lists
// directories, and a ref becomes one only when someone opens it, so nothing here is pushed or
// persisted: it is asked for, ranked, and forgotten.
//
// The ranking is pure so its rules have tests without a repo; the class around it owns the two
// things that cost something, the git calls and gh.

import type { RefHit, RepoInfo } from "@toyon/shared";
import { canonical } from "../agent/bounds.ts";
import { log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { run } from "../git/exec.ts";
import { type GitRef, listRefs, mergedBranches } from "../git/refs.ts";
import { discoveredId } from "./discover.ts";

/** one open PR as gh reports it, trimmed to what the palette shows and what opening one needs */
export interface PrHit {
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  /** the branch the PR is from; on a fork, a branch this repo does not have */
  head: string;
  fork: boolean;
  updatedAt: number;
}

/** how long a PR list stands before gh is asked again: a PR opened a minute ago is missing for
 * a minute, and a palette keystroke never shells out */
const PR_TTL_MS = 60_000;
const PR_LIMIT = 50;

export interface RefSearchDeps {
  state: StateStore;
  /** the open PRs of a repo; the default asks gh. A test hands in a stub, and a stub that throws
   * proves the failure is swallowed, since a missing gh is a repo without PRs, never a refusal. */
  prs?: (repo: RepoInfo) => Promise<PrHit[]>;
}

export class RefSearch {
  private prCache = new Map<string, { prs: PrHit[]; at: number }>();

  constructor(private d: RefSearchDeps) {}

  async search(repoId: string, query: string): Promise<RefHit[]> {
    const repo = this.d.state.requireRepo(repoId);
    const [refs, merged, prs] = await Promise.all([
      listRefs(repo.path),
      mergedBranches(repo.path, repo.defaultBranch),
      this.openPrs(repo),
    ]);
    return rankRefs({ refs, merged, prs, query, defaultBranch: repo.defaultBranch, rowIdForPath: this.rowIdForPath });
  }

  /** the PR by number, for opening one: from the cache, else one more ask */
  async pr(repoId: string, number: number): Promise<PrHit | null> {
    const repo = this.d.state.requireRepo(repoId);
    return (await this.openPrs(repo)).find((p) => p.number === number) ?? null;
  }

  private async openPrs(repo: RepoInfo): Promise<PrHit[]> {
    const cached = this.prCache.get(repo.id);
    if (cached && Date.now() - cached.at < PR_TTL_MS) return cached.prs;
    let prs: PrHit[] = [];
    try {
      prs = await (this.d.prs ?? ghPrs)(repo);
    } catch (e) {
      // no gh, not logged in, no GitHub remote: a repo without PRs, and cached as one so a
      // palette open does not shell out to fail again on every keystroke
      log.debug(repo.id, "no PR list", e);
    }
    this.prCache.set(repo.id, { prs, at: Date.now() });
    return prs;
  }

  /** the row id a checked-out branch resolves to: toyon's own record by path, or the id a found
   * worktree at that path is pushed with, which is derived from the path the same way */
  private rowIdForPath = (path: string): string | null => {
    const want = canonical(path);
    for (const wt of this.d.state.worktrees) {
      if (canonical(wt.path) === want || (wt.linkPath && canonical(wt.linkPath) === want)) return wt.id;
    }
    return discoveredId(path);
  };
}

/** ask gh for the repo's open PRs. Absence and failure both come back as none: `run` never
 * throws, and a repo with no GitHub remote has no PRs to list. */
export async function ghPrs(repo: RepoInfo): Promise<PrHit[]> {
  const fields = "number,title,url,author,headRefName,isDraft,isCrossRepository,updatedAt";
  const r = await run(
    "gh",
    ["pr", "list", "--state", "open", "--limit", String(PR_LIMIT), "--json", fields],
    repo.path,
  );
  if (!r.ok || !r.out) return [];
  return parsePrList(r.out);
}

/** gh's JSON, kept defensively: a row missing what the palette needs is dropped, not thrown on */
export function parsePrList(json: string): PrHit[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out: PrHit[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const number = row.number;
    const head = row.headRefName;
    if (typeof number !== "number" || typeof head !== "string") continue;
    const author = row.author as { login?: unknown } | undefined;
    out.push({
      number,
      title: typeof row.title === "string" ? row.title : "",
      url: typeof row.url === "string" ? row.url : "",
      author: typeof author?.login === "string" ? author.login : "",
      draft: row.isDraft === true,
      head,
      fork: row.isCrossRepository === true,
      updatedAt: typeof row.updatedAt === "string" ? Date.parse(row.updatedAt) || 0 : 0,
    });
  }
  return out;
}

export interface RankInput {
  refs: GitRef[];
  merged: Set<string>;
  prs: PrHit[];
  query: string;
  defaultBranch: string;
  rowIdForPath: (path: string) => string | null;
}

/** The palette's rows for a query.
 *
 * Empty query: the work that is open. Local branches with no worktree and commits main does not
 * have, and the open PRs. Merged branches are landed or never started, and a branch that is
 * checked out is already a row in the rail; listing either would be noise, and nine of them is
 * what discovery looked like before the section collapsed.
 *
 * A typed query searches everything by name, subject, PR title or `#<n>`: merged branches marked
 * as such, checked-out ones resolving to the row that has them, and remote branches as of the
 * last fetch. A local branch shadows its remote of the same name, since opening the local is what
 * "open origin/x" would do anyway. */
export function rankRefs({ refs, merged, prs, query, defaultBranch, rowIdForPath }: RankInput): RefHit[] {
  const q = query.trim().toLowerCase();
  const locals = refs.filter((r) => !r.remote && r.name !== defaultBranch);
  const localNames = new Set(locals.map((r) => r.name));
  const byName = new Map(locals.map((r) => [r.name, r]));
  const openIn = (r: GitRef | undefined) => (r?.worktreePath ? (rowIdForPath(r.worktreePath) ?? undefined) : undefined);

  const hits: Array<RefHit & { rank: number; at: number }> = [];
  const matches = (...texts: Array<string | undefined>) => !q || texts.some((t) => t?.toLowerCase().includes(q));
  const rank = (name: string) => (q && name.toLowerCase().startsWith(q) ? 0 : 1);

  for (const r of locals) {
    const hit: RefHit = { kind: "branch", ref: r.name, name: r.name, subject: r.subject, at: r.at };
    const isMerged = merged.has(r.name);
    const where = openIn(r);
    if (!q && (isMerged || where)) continue;
    if (!matches(r.name, r.subject)) continue;
    hits.push({
      ...hit,
      ...(isMerged ? { merged: true } : {}),
      ...(where ? { openIn: where } : {}),
      rank: rank(r.name),
      at: r.at,
    });
  }
  if (q) {
    for (const r of refs) {
      if (!r.remote || localNames.has(r.name) || r.name === defaultBranch) continue;
      if (!matches(r.name, r.subject, `${r.remote}/${r.name}`)) continue;
      hits.push({
        kind: "remote",
        ref: r.name,
        name: `${r.remote}/${r.name}`,
        subject: r.subject,
        at: r.at,
        rank: rank(r.name) + 1,
      });
    }
  }
  for (const p of prs) {
    if (!matches(p.title, p.head, `#${p.number}`, String(p.number))) continue;
    // its head branch checked out here, or the branch a previous open fetched it into
    const where = openIn(byName.get(p.head)) ?? openIn(byName.get(`pr/${p.number}`));
    hits.push({
      kind: "pr",
      ref: String(p.number),
      name: `#${p.number} ${p.title}`,
      at: p.updatedAt,
      pr: {
        number: p.number,
        url: p.url,
        title: p.title,
        author: p.author,
        head: p.head,
        ...(p.draft ? { draft: true } : {}),
        ...(p.fork ? { fork: true } : {}),
      },
      ...(where ? { openIn: where } : {}),
      rank: q && (`#${p.number}`.startsWith(q) || String(p.number).startsWith(q)) ? 0 : rank(p.title),
    });
  }
  hits.sort((a, b) => a.rank - b.rank || b.at - a.at);
  return hits.map(({ rank: _rank, at, ...hit }) => ({ ...hit, ...(at ? { at } : {}) }));
}
