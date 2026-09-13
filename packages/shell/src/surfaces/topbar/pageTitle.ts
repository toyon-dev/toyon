// A page's name as the route list shows it: the title the app gave it, less the site name every
// page repeats, or a word made from its path when the app names nothing useful.

/** where apps join a page's name to the site's: "Pricing | Acme", "Docs - Acme", "Acme: Pricing".
 * The en dash, em dash and middot are escapes, so a copy check reading this file sees none of them. */
const SEPARATOR = / \| | - | \u2013 | \u2014 | \u00b7 |: /;

/** a segment that names a record rather than a page: a number, a uuid, a long hex id */
const ID_LIKE = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{12,})$/i;

/** a segment that is a parameter in some router's syntax */
const PARAM = /^[[:$*{]|\[/;

/**
 * Each titled page's own name. Titles are split where apps join names, and any part two or more pages
 * share is dropped, so "Pricing | Acme" and "Docs | Acme" read "Pricing" and "Docs". Nothing is
 * trusted until two different pages have titles, since one title alone may be the site's name on
 * every page. A page left with nothing is not in the map.
 */
export function pageTitles(pages: Array<{ path: string; title?: string }>): Map<string, string> {
  const out = new Map<string, string>();
  const titled = pages.filter((p): p is { path: string; title: string } => !!p.title);
  if (new Set(titled.map((p) => p.path)).size < 2) return out;
  const split = titled.map((p) => ({
    path: p.path,
    parts: p.title
      .split(SEPARATOR)
      .map((s) => s.trim())
      .filter(Boolean),
  }));
  const shared = new Map<string, Set<string>>();
  for (const { path, parts } of split) {
    for (const part of parts) shared.set(part, (shared.get(part) ?? new Set()).add(path));
  }
  for (const { path, parts } of split) {
    const own = parts.filter((part) => (shared.get(part)?.size ?? 0) < 2);
    if (own.length > 0) out.set(path, own.join(" "));
  }
  return out;
}

/** a name made from a path: its last segment that is a word, not an id or a parameter; the root is Home */
export function humanize(path: string): string {
  const segs = path.split(/[/#]/).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    let seg = segs[i]!;
    try {
      seg = decodeURIComponent(seg);
    } catch {
      // a malformed escape is still a readable segment as it stands
    }
    if (ID_LIKE.test(seg) || PARAM.test(seg)) continue;
    const words = seg.replace(/[-_.]+/g, " ").trim();
    if (words) return words[0]!.toUpperCase() + words.slice(1);
  }
  return "Home";
}
