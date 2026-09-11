// The key a preview page is remembered under in the route bar's list. The shell computes it from
// the page's address and the daemon recomputes it from what the shell sent, so both agree on what
// counts as the same page without the daemon trusting the frame.

const BASE = "http://preview.invalid";

/**
 * The page an address names, as the route bar lists it: the path, plus the hash when the app routes
 * on it (`#/about`). The query is dropped, inside a hash route too: `?tab=2` would split one page
 * into many, and a query is where reset tokens and invite codes travel, which have no business in
 * the daemon's state file. A trailing slash is dropped except at the root, and toyon's own
 * `/__toyon` paths are not pages. Accepts a full URL or a path; null when there is nothing to key.
 */
export function routeKey(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href, BASE);
  } catch {
    return null;
  }
  if (u.pathname.startsWith("/__toyon")) return null;
  const path = trimSlash(u.pathname) || "/";
  const hash = u.hash.startsWith("#/") ? trimSlash(u.hash.split("?")[0] ?? "") : "";
  // `#/` alone is the hash router's root, which is the page itself
  return hash.length > 1 ? `${path}${hash}` : path;
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");
