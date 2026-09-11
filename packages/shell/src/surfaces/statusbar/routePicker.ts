// The route bar's rows, from what was typed and the pages the project's previews are used on.
// Pure, so the ordering rules are tested without a DOM.

export type Row = { kind: "go" | "frequent"; path: string };

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

/**
 * The field opens holding the page's own address, selected, so typing replaces it. Until something
 * is typed the address is not a filter and every page is listed. Once it is, the rows narrow, and a
 * typed path that is not already a row leads as a `go` row, so enter always goes somewhere.
 * The page on screen is never listed: going there is what the reload button is for.
 */
export function rowsFor({
  query,
  current,
  here,
  frequent,
}: {
  query: string;
  /** the address the field opened with */
  current: string;
  /** the page on screen, keyed the way the list is */
  here: string | null;
  frequent: string[];
}): Row[] {
  const typed = query.trim() !== "" && query !== current;
  const pages = frequent.filter((p) => p !== here && (!typed || matches(p, query)));
  const rows: Row[] = [];
  if (typed) {
    const go = normalizePath(query);
    if (!pages.includes(go)) rows.push({ kind: "go", path: go });
  }
  for (const path of pages) rows.push({ kind: "frequent", path });
  return rows;
}
