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
  | { kind: "clone"; url: string; name: string }
  /** the way in for someone who does not know a name can be typed here: the form, with nothing filled */
  | { kind: "new" };

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
  pending: PendingRepo[];
  entries: PathEntry[];
  target: PathTarget | null;
  /** the query the daemon's entries and target actually describe (`paths.query`) */
  answered: string;
}): Row[] {
  const q = input.query.trim();
  const dirRows = (): Row[] => input.entries.map((entry): Row => ({ kind: "dir", entry }));

  if (!looksLikePath(q)) {
    const repos = input.repos.filter((r) => byName(q, r.name, r.path)).map((repo): Row => ({ kind: "repo", repo }));
    // an import is a project you are getting, so it belongs in the list of projects rather than
    // somewhere separate; it sorts after the real ones because you cannot open it yet
    const pending = input.pending
      .filter((p) => byName(q, p.name, p.url))
      .map((p): Row => ({ kind: "pending", pending: p }));
    const listed = [...repos, ...pending];
    // last, so it never pushes a project off the top of the list, and ↑ from the first row reaches it
    if (!q) return [...listed, { kind: "new" }];
    // a URL is not a name and not a path: it is the third thing someone pastes in here
    const url = gitUrl(q);
    if (url) return listed.length > 0 ? listed : [{ kind: "clone", url: url.url, name: url.name }];
    // Matching is by substring of the name or the path, so a new name routinely matches without
    // being taken: `site` finds toyon-site, and `projects` finds everything in ~/Projects. Only a
    // project already called exactly that is the project rather than an offer to make another.
    const same = (n: string) => n.toLowerCase() === q.toLowerCase();
    if (input.repos.some((r) => same(r.name)) || input.pending.some((p) => same(p.name))) return listed;
    if (projectNameError(q)) return listed;
    // `parent: null` means "wherever this person keeps projects", which the form fills in, because a
    // bare name says nothing about location
    return [...listed, { kind: "create", name: q, parent: null }];
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

/** a row of the folder chooser, where the new-project form's location is walked to. `here` is the
 * folder being listed, and choosing it is the pick; `up` and `dir` only move the listing. */
export type FolderRow =
  | { kind: "here"; path: string }
  | { kind: "up"; path: string }
  | { kind: "dir"; entry: PathEntry };

/** `~/Projects` as `/Users/k/Projects`, for comparing paths the daemon and the person wrote differently */
export function expandHome(path: string, home: string): string {
  if (!home) return path;
  return path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

/** the folder a path sits in, written back the way it would be typed; null at the top of the disk */
export function parentFolder(path: string, home: string): string | null {
  const abs = expandHome(path, home).replace(/\/+$/, "");
  // "" was "/", and anything still not absolute is `~` with no home known, or relative
  if (!abs.startsWith("/")) return null;
  return collapseHome(abs.slice(0, abs.lastIndexOf("/")) || "/", home);
}

/** what a folder is called, which for `~` is the home folder's own name */
export function folderName(path: string, home: string): string {
  const abs = expandHome(path, home).replace(/\/+$/, "");
  return abs.slice(abs.lastIndexOf("/") + 1) || "/";
}

export function folderRows(input: {
  query: string;
  entries: PathEntry[];
  target: PathTarget | null;
  /** the query the daemon's entries and target actually describe (`paths.query`) */
  answered: string;
  home: string;
}): FolderRow[] {
  const q = input.query.trim();
  const cut = q.lastIndexOf("/");
  // the listed folder is everything up to the last slash; after it is a prefix being typed
  const here = cut < 0 ? "" : q.slice(0, cut) || "/";
  const inHere = expandHome(here, input.home);
  if (!looksLikePath(q) || !inHere.startsWith("/")) return [];
  const prefix = q.slice(cut + 1).toLowerCase();

  // Until the daemon has looked, assume the folder is there: nearly every query here is a click into
  // a folder it just listed, and hiding the row for the debounce would move every row under the
  // pointer. Once it has looked, a folder that is not there (or is a project) is not offered.
  const seen = input.answered.trim() === q ? input.target : null;
  const usable = !seen || (prefix ? seen.parentExists : seen.exists && seen.isDir && !seen.isRepo);

  const dirs = input.entries.filter((e) => {
    // a project is not a place to put one: a repo made inside another's checkout shows up in its changes
    if (e.isRepo) return false;
    // the answer can still be for the folder just left, and a stale row is one a click lands on
    const abs = expandHome(e.path, input.home);
    return (abs.slice(0, abs.lastIndexOf("/")) || "/") === inHere && e.name.toLowerCase().startsWith(prefix);
  });

  const up = parentFolder(here, input.home);
  return [
    ...(usable ? [{ kind: "here" as const, path: here }] : []),
    ...(up ? [{ kind: "up" as const, path: up }] : []),
    ...dirs.map((entry) => ({ kind: "dir" as const, entry })),
  ];
}
