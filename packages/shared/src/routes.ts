// The key a preview page is remembered under in the route bar's list. The shell computes it from
// the page's address and the daemon recomputes it from what the shell sent, so both agree on what
// counts as the same page without the daemon trusting the frame.

const BASE = "http://preview.invalid";

/** the router whose file layout a page was read from */
export type RouteSource = "next" | "nuxt" | "sveltekit" | "remix" | "astro" | "solid" | "tanstack";

/** a page, or an endpoint, that a worktree's files define under a file-based router */
export interface RouteInfo {
  /** in the router's own syntax for a parameter: `/users/[id]`, `/users/:id`, `/users/$id` */
  path: string;
  source: RouteSource;
  /** the file that defines it, relative to the worktree */
  file: string;
  /** has a parameter, so it is a template to fill in rather than a place */
  dynamic: boolean;
  /** answers requests rather than drawing a page: a Next route handler, a SvelteKit +server */
  endpoint: boolean;
}

/** the longest page title kept: past this it is a sentence, not a name */
export const TITLE_MAX = 200;

/** A page in a repo's history as the shell is sent it: best first, with the title it had when last
 * visited. `score` is as of the last send; decay scales every score alike, so the order stands. */
export interface PageEntry {
  path: string;
  title?: string;
  score: number;
  last: number;
}

/** a page title as it is kept: whitespace collapsed, trimmed, capped; undefined when nothing is left */
export function cleanTitle(title: string | undefined): string | undefined {
  const t = title?.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX).trim();
  return t ? t : undefined;
}

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

/** what a page has become since you last had it open in this worktree */
export type PageBadge = "new" | "changed";

/** A worktree's pages as the shell is sent them: every route its files define, and, keyed by file,
 * the ones whose file changed since you last had that page open there. */
export interface WorktreePages {
  routes: RouteInfo[];
  unseen: Record<string, PageBadge>;
}

type Segment =
  | { kind: "static"; text: string }
  | { kind: "optional-static"; text: string }
  | { kind: "param"; name: string }
  | { kind: "optional"; name: string }
  | { kind: "splat"; name: string; min: 0 | 1 }
  | { kind: "mixed"; pattern: string; parts: Array<{ text: string } | { name: string }> };

/** a route with parameters, compiled once so remembered pages can be matched against it */
export interface Template {
  path: string;
  re: RegExp;
  /** how particular it is: a literal segment outweighs a parameter, and a parameter a splat */
  specificity: number;
  /** literal segments; a template with none (a catch-all at the root) never gathers pages */
  statics: number;
}

const WEIGHT: Record<Segment["kind"], number> = {
  static: 4,
  mixed: 3.5,
  param: 3,
  optional: 2,
  "optional-static": 2,
  splat: 1,
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** one segment in any router's syntax: Next and SvelteKit brackets, React Router and Remix colons
 * and stars, TanStack dollars and braces */
function segmentOf(s: string): Segment {
  const optionalSplat = /^\[\[\.\.\.([^\]]*)\]\]$/.exec(s);
  if (optionalSplat) return { kind: "splat", name: optionalSplat[1] || "path", min: 0 };
  const splat = /^\[\.\.\.([^\]]*)\]$/.exec(s);
  if (splat) return { kind: "splat", name: splat[1] || "path", min: 1 };
  const optional = /^\[\[([^\]]+)\]\]$/.exec(s) ?? /^:([\w-]+)\?$/.exec(s) ?? /^\{-\$([\w-]+)\}$/.exec(s);
  if (optional) return { kind: "optional", name: optional[1]! };
  const param = /^\[([^\]=]+)(?:=[^\]]*)?\]$/.exec(s) ?? /^:([\w-]+)$/.exec(s) ?? /^\$([\w-]+)$/.exec(s);
  if (param) return { kind: "param", name: param[1]! };
  if (s === "*" || s === "$") return { kind: "splat", name: "path", min: 0 };
  if (/^[^[{:$*?]+\?$/.test(s)) return { kind: "optional-static", text: s.slice(0, -1) };
  if (/[[{]/.test(s)) {
    const parts: Array<{ text: string } | { name: string }> = [];
    let pattern = "";
    let at = 0;
    for (const t of s.matchAll(/\[([^\]=]+)(?:=[^\]]*)?\]|\{\$([\w-]+)\}/g)) {
      const before = s.slice(at, t.index);
      if (before) {
        parts.push({ text: before });
        pattern += escapeRe(before);
      }
      parts.push({ name: t[1] ?? t[2] ?? "param" });
      pattern += "[^/]+?";
      at = (t.index ?? 0) + t[0].length;
    }
    const tail = s.slice(at);
    if (tail) {
      parts.push({ text: tail });
      pattern += escapeRe(tail);
    }
    if (parts.some((p) => "name" in p)) return { kind: "mixed", pattern, parts };
  }
  return { kind: "static", text: s };
}

/** a route as a template to match pages against; null for a path with no parameter in it */
export function compileRoute(path: string): Template | null {
  const segs = path.split("/").filter(Boolean).map(segmentOf);
  if (segs.every((s) => s.kind === "static")) return null;
  let re = "";
  for (const s of segs) {
    if (s.kind === "static") re += `/${escapeRe(s.text)}`;
    else if (s.kind === "optional-static") re += `(?:/${escapeRe(s.text)})?`;
    else if (s.kind === "param") re += "/[^/]+";
    else if (s.kind === "optional") re += "(?:/[^/]+)?";
    else if (s.kind === "splat") re += s.min ? "/.+" : "(?:/.*)?";
    else re += `/${s.pattern}`;
  }
  return {
    path,
    re: new RegExp(`^${re}$`),
    specificity: segs.reduce((n, s) => n + WEIGHT[s.kind], 0),
    statics: segs.filter((s) => s.kind === "static").length,
  };
}

/** The most particular template a page falls under, or null. A template with no literal segment is
 * never the answer: a catch-all at the root would gather every page you have been to. */
export function templateFor(templates: Template[], key: string): Template | null {
  let best: Template | null = null;
  for (const t of templates) {
    if (t.statics === 0 || !t.re.test(key)) continue;
    if (!best || t.specificity > best.specificity) best = t;
  }
  return best;
}

/** A template as the route list draws it, the same for every router: each parameter as a plain
 * word (`/users/id`), where those words sit, and the literal text before the first of them. */
export function templateText(path: string): { text: string; params: Array<[number, number]>; literal: string } {
  let text = "";
  const params: Array<[number, number]> = [];
  const word = (name: string) => {
    params.push([text.length, text.length + name.length]);
    text += name;
  };
  for (const seg of path.split("/").filter(Boolean).map(segmentOf)) {
    text += "/";
    if (seg.kind === "static" || seg.kind === "optional-static") text += seg.text;
    else if (seg.kind === "mixed") {
      for (const p of seg.parts) {
        if ("name" in p) word(p.name);
        else text += p.text;
      }
    } else word(seg.name);
  }
  if (!text) text = "/";
  return { text, params, literal: params.length > 0 ? text.slice(0, params[0]![0]) : text };
}
