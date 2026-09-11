// The links a preview's pages show, for an app whose files and code declare no page: the only way the
// route list can offer somewhere to go in a plain multi-page site.

import { type PageLink, routeKey, type WorktreePages } from "@toyon/shared";

/** links kept per worktree: a footer sitemap should not bury the pages you actually use */
export const LINKS_MAX = 200;

/** A page's links merged into what earlier pages showed, keyed the way the route list keys pages. The
 * same array back when nothing was new, so a selector reading it stays still. */
export function mergeLinks(had: PageLink[], more: PageLink[]): PageLink[] {
  const out = new Map(had.map((l) => [l.path, l]));
  for (const l of more) {
    if (out.size >= LINKS_MAX) break;
    const key = routeKey(l.path);
    if (key && !out.has(key)) out.set(key, { path: key, text: l.text });
  }
  return out.size === had.length ? had : [...out.values()];
}

/** Ask the preview for its links only once the worktree's pages have arrived and hold no page: an
 * app with a route table already lists better than its links could. */
export function wantsLinks(pages: WorktreePages | undefined): boolean {
  return pages !== undefined && !pages.routes.some((r) => !r.endpoint);
}
