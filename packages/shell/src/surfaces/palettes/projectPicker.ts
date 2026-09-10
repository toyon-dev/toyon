// What the project picker offers for a given query. Kept out of the component so the rules that
// decide whether a row promises something the daemon will actually do are testable on their own.

import {
  gitUrl,
  type PathEntry,
  type PathTarget,
  type PendingRepo,
  projectNameError,
  type RepoInfo,
} from "@toyon/shared";
import { byName } from "./commands.ts";

export type Row =
  | { kind: "repo"; repo: RepoInfo }
  /** a clone still running: pickable, so it can be watched or stopped */
  | { kind: "pending"; pending: PendingRepo }
  | { kind: "dir"; entry: PathEntry }
  /** an existing repo on disk that this daemon has not registered yet */
  | { kind: "open"; path: string }
  /** somewhere a project could be made: one new folder under a parent that is already there */
  | { kind: "create"; name: string; parent: string | null }
  | { kind: "clone"; url: string; name: string };

/** a typed path is a filesystem query rather than a name filter */
export const looksLikePath = (q: string) => /^(~|\/|\.\.?\/)/.test(q.trim());

/** split a typed path into the folder it would go in and the leaf it would be */
export function splitTypedPath(q: string): { parent: string; name: string } {
  const typed = q.trim().replace(/\/+$/, "");
  const cut = typed.lastIndexOf("/");
  if (cut < 0) return { parent: "", name: typed };
  // "/foo" lives in "/", which is the one parent whose name is its separator
  return { parent: typed.slice(0, cut) || "/", name: typed.slice(cut + 1) };
}

/** the folder most of this person's projects already live in, so a new one is offered beside them.
 * Derived rather than configured: there is no "projects directory" setting to get wrong, and no
 * assumption that anyone keeps them in ~/Projects. */
export function defaultParent(repos: RepoInfo[], activeRepoId: string | null, home: string): string {
  const dirs = repos.map((r) => r.path.slice(0, r.path.lastIndexOf("/"))).filter(Boolean);
  const active = repos.find((r) => r.id === activeRepoId);
  const activeDir = active?.path.slice(0, active.path.lastIndexOf("/"));
  const counts = new Map<string, number>();
  for (const d of dirs) counts.set(d, (counts.get(d) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [dir, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    // ties go to the open project's own folder, then to whichever sorts first, so the answer is
    // stable rather than dependent on the order repos happened to be registered in
    const wins = n > bestCount || (n === bestCount && dir === activeDir);
    if (wins) {
      best = dir;
      bestCount = n;
    }
  }
  return collapseHome(best || activeDir || home, home);
}

/** `/Users/k/Projects` as `~/Projects`, the way it would be typed back in. Only on a segment
 * boundary: `/Users/kshaya` is not inside `/Users/kshay`. */
export function collapseHome(abs: string, home: string): string {
  if (!home) return abs;
  return abs === home || abs.startsWith(`${home}/`) ? `~${abs.slice(home.length)}` : abs;
}

/** the path a name and a folder would make, for the form to show before it commits to anything */
export function destination(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, "")}/${name.trim()}`;
}

export function rowsFor(input: {
  query: string;
  repos: RepoInfo[];
  activeRepoId: string | null;
  pending: PendingRepo[];
  entries: PathEntry[];
  target: PathTarget | null;
  /** the query the daemon's entries and target actually describe (`paths.query`) */
  answered: string;
}): Row[] {
  const q = input.query.trim();
  const dirRows = (): Row[] => input.entries.map((entry): Row => ({ kind: "dir", entry }));

  if (!looksLikePath(q)) {
    const repos = input.repos
      .filter((r) => r.id !== input.activeRepoId && byName(q, r.name, r.path))
      .map((repo): Row => ({ kind: "repo", repo }));
    // an import is a project you are getting, so it belongs in the list of projects rather than
    // somewhere separate; it sorts after the real ones because you cannot open it yet
    const pending = input.pending
      .filter((p) => byName(q, p.name, p.url))
      .map((p): Row => ({ kind: "pending", pending: p }));
    if (repos.length > 0 || pending.length > 0 || !q) return [...repos, ...pending];
    // a URL is not a name and not a path: it is the third thing someone pastes in here
    const url = gitUrl(q);
    if (url) return [{ kind: "clone", url: url.url, name: url.name }];
    // nothing by that name, so offer to make it. `parent: null` means "wherever this person keeps
    // projects", which the form fills in, because a bare name says nothing about location.
    return projectNameError(q) ? [] : [{ kind: "create", name: q, parent: null }];
  }

  // The daemon is 150ms behind the keystrokes, so its answer routinely describes the previous
  // query. Offering a create row from a stale "nothing here" would flash a row for a path nobody
  // has looked at yet, and then replace it.
  if (input.answered.trim() !== q || !input.target) return dirRows();
  const { target } = input;

  // a trailing slash names a folder to look inside, not a leaf to make
  if (q.endsWith("/")) return dirRows();
  if (target.exists) {
    // an unregistered repo can be opened; a plain folder is a step on the way and enter descends
    return target.isRepo ? [...dirRows(), { kind: "open", path: q }] : dirRows();
  }
  if (!target.parentExists) return []; // a typo: the empty state says to keep typing
  const { parent, name } = splitTypedPath(q);
  return projectNameError(name) ? dirRows() : [...dirRows(), { kind: "create", name, parent }];
}
