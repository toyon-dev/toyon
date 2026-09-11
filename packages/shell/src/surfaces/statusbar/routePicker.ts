// The route bar's rows, from what was typed, the pages this branch changed and the pages the
// project's previews are used on. Pure, so the ordering rules are tested without a DOM.

import type { PageBadge, RouteInfo } from "@toyon/shared";

export type Row =
  | { kind: "go"; path: string }
  | { kind: "changed"; path: string; file: string; dynamic: boolean }
  | { kind: "frequent"; path: string };

/** A branch that touched every page still leaves the list room for the pages you use. */
export const CHANGED_MAX = 8;

/** the address as the bar shows it: path, query and hash, since a hash router's route is its hash */
export function pathOf(url: string | undefined): string {
  if (!url) return "/";
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

/** where a typed path navigates: "/path", "?query" and "#/hash-route" are valid as typed, and
 * anything else is a path */
export function normalizePath(q: string): string {
  const t = q.trim();
  return /^[/?#]/.test(t) ? t : `/${t}`;
}

/** case-insensitive substring, ignoring one leading slash on either side, so "about" finds "/about" */
export function matches(path: string, q: string): boolean {
  const needle = q.trim().replace(/^\//, "").toLowerCase();
  return !needle || path.replace(/^\//, "").toLowerCase().includes(needle);
}

/** what a row completes the query to, in the form it was typed: with the slash when it was typed
 * with one, without when it was not, so the ghost lines up with the caret */
export function completionFor(path: string, q: string): string | null {
  const c = /^[/?#]/.test(q) ? path : path.replace(/^\//, "");
  return q && c.toLowerCase().startsWith(q.toLowerCase()) ? c : null;
}

/** The pages whose file changed since you last had them open here, in the scan's order (places
 * before templates). Endpoints never carry a badge, since sending the preview to a handler's JSON is
 * rarely where anyone meant to go. */
export function changedRoutes(
  routes: RouteInfo[] | undefined,
  unseen: Record<string, PageBadge> | undefined,
): RouteInfo[] {
  if (!routes?.length || !unseen) return [];
  return routes.filter((r) => !r.endpoint && unseen[r.file]).slice(0, CHANGED_MAX);
}

/**
 * The field opens holding the page's own address, selected, so typing replaces it. Until something
 * is typed the address is not a filter and every row is listed: the pages this branch changed, then
 * the pages you use. Once it is, the rows narrow, and a typed path that is not already a row leads
 * as a `go` row, so enter always goes somewhere. The page on screen is left out, since going there
 * is what reload is for; a changed template stays, since it is not a place until it is filled in.
 */
export function rowsFor({
  query,
  current,
  here,
  frequent,
  changed,
}: {
  query: string;
  /** the address the field opened with */
  current: string;
  /** the page on screen, keyed the way the list is */
  here: string | null;
  frequent: string[];
  changed: RouteInfo[];
}): Row[] {
  const typed = query.trim() !== "" && query !== current;
  const keep = (path: string) => !typed || matches(path, query);
  const rows: Row[] = changed
    .filter((r) => (r.dynamic || r.path !== here) && keep(r.path))
    .map((r): Row => ({ kind: "changed", path: r.path, file: r.file, dynamic: r.dynamic }));
  // a page both changed and visited is listed once, as changed
  const changedPaths = new Set(changed.map((r) => r.path));
  for (const path of frequent) {
    if (path !== here && !changedPaths.has(path) && keep(path)) rows.push({ kind: "frequent", path });
  }
  if (typed) {
    const go = normalizePath(query);
    // a template sitting in the field is its own row already
    if (!rows.some((r) => r.path === go)) rows.unshift({ kind: "go", path: go });
  }
  return rows;
}
