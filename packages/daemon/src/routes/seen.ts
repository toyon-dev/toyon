// Which of a worktree's pages changed since you last had them open there: the badge on a route list
// row. Pure: the service reads the files and hands their hashes in.

import type { PageBadge, RouteInfo } from "@toyon/shared";

/** what a worktree remembers about the page files opened in it */
export interface SeenPages {
  /** the file on screen, stamped again when it is left */
  here?: string;
  /** file to the hash of what it held when its page was last open */
  files: Record<string, string>;
}

/** a changed file as git status reports it */
export type ChangedFile = { path: string; xy: string };

const isAdded = (xy: string) => xy === "??" || xy.startsWith("A");

/** The files whose page could carry a badge: changed, a page and not an endpoint, not on screen, and
 * the only route its file defines. A file defining several (an App.tsx with its pages inline) says
 * nothing about any one of them, so it never badges. A file listed as both uncommitted and committed
 * ahead is one candidate, added if either says so. */
export function badgeCandidates(routes: RouteInfo[], changed: ChangedFile[], here?: string): ChangedFile[] {
  const perFile = new Map<string, number>();
  for (const r of routes) perFile.set(r.file, (perFile.get(r.file) ?? 0) + 1);
  const pageFiles = new Set(routes.filter((r) => !r.endpoint).map((r) => r.file));
  const out = new Map<string, ChangedFile>();
  for (const f of changed) {
    if (f.path === here || !pageFiles.has(f.path) || perFile.get(f.path) !== 1) continue;
    const had = out.get(f.path);
    if (!had || (!isAdded(had.xy) && isAdded(f.xy))) out.set(f.path, f);
  }
  return [...out.values()];
}

/** The badge each candidate carries: `new` for a file never opened here that git says was added,
 * `changed` for one never opened that already existed or one whose content moved since you had it
 * open. A file that holds what you saw carries none, and one gone by the time it was read, nothing. */
export function unseenOf(
  candidates: ChangedFile[],
  seen: SeenPages | undefined,
  hashes: Record<string, string>,
): Record<string, PageBadge> {
  const out: Record<string, PageBadge> = {};
  for (const f of candidates) {
    const now = hashes[f.path];
    if (now === undefined) continue;
    const then = seen?.files[f.path];
    if (then === undefined) out[f.path] = isAdded(f.xy) ? "new" : "changed";
    else if (then !== now) out[f.path] = "changed";
  }
  return out;
}
