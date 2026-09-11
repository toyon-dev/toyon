// Which pages a worktree's files define, for the routers that make the file layout the route table.
// Pure: it takes the worktree's paths and its manifests' dependency names and reads nothing, so each
// framework's layout is a list of paths in the test.

import type { RouteInfo, RouteSource } from "@toyon/shared";

/** build output and dependencies: never routes, and never a project's own manifest */
const SKIP = /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.nuxt|\.output|\.svelte-kit|\.vercel|\.netlify)\//;

/** the dependency that names each router. A meta-framework comes before the router it is built on,
 * since its manifest lists both. */
const DEPENDENCIES: Array<[RouteSource, RegExp]> = [
  ["next", /^next$/],
  ["nuxt", /^nuxt$/],
  ["sveltekit", /^@sveltejs\/kit$/],
  ["astro", /^astro$/],
  ["solid", /^@solidjs\/start$/],
  ["remix", /^(@remix-run\/(react|node|dev)|@react-router\/dev)$/],
  ["tanstack", /^@tanstack\/(react|solid)-(router|start)$/],
];

/** a config file that names its framework where no manifest did */
const CONFIGS: Array<[RouteSource, RegExp]> = [
  ["next", /^next\.config\.(js|mjs|cjs|ts)$/],
  ["nuxt", /^nuxt\.config\.(js|mjs|ts)$/],
  ["sveltekit", /^svelte\.config\.(js|mjs|ts)$/],
  ["astro", /^astro\.config\.(js|mjs|ts)$/],
  ["remix", /^(remix|react-router)\.config\.(js|mjs|ts)$/],
];

export const MAX_ROUTES = 500;

export interface Manifest {
  /** the directory the package.json is in, relative to the worktree, with its slash: "" or "apps/web/" */
  dir: string;
  deps: string[];
}

/** a package.json worth reading: the project's own, not one inside its dependencies or its build */
export function isManifest(path: string): boolean {
  return /(^|\/)package\.json$/.test(path) && !SKIP.test(path);
}

/** Each project root in the worktree and the router it uses; a monorepo has several. A manifest's
 * dependencies decide, and a config file stands in where no manifest named a router. */
export function frameworksOf(paths: string[], manifests: Manifest[]): Map<string, RouteSource> {
  const roots = new Map<string, RouteSource>();
  for (const m of manifests) {
    const hit = DEPENDENCIES.find(([, re]) => m.deps.some((d) => re.test(d)));
    if (hit) roots.set(m.dir, hit[0]);
  }
  for (const p of paths) {
    if (SKIP.test(p)) continue;
    const cut = p.lastIndexOf("/") + 1;
    const dir = p.slice(0, cut);
    if (roots.has(dir)) continue;
    const hit = CONFIGS.find(([, re]) => re.test(p.slice(cut)));
    if (hit) roots.set(dir, hit[0]);
  }
  return roots;
}

type Found = Omit<RouteInfo, "source">;

/** Every route the files under each root define, places before templates. A root's reader looks
 * only where its router looks, so a sibling app without a router of its own adds nothing. */
export function fileRoutes(paths: string[], roots: Map<string, RouteSource>): RouteInfo[] {
  if (roots.size === 0) return [];
  // the deepest root claims its files, so an app nested inside a project that is one too is its own
  const dirs = [...roots.keys()].sort((a, b) => b.length - a.length);
  const byRoot = new Map<string, string[]>();
  for (const p of paths) {
    if (SKIP.test(p)) continue;
    const dir = dirs.find((d) => p.startsWith(d));
    if (dir === undefined) continue;
    const rels = byRoot.get(dir) ?? [];
    rels.push(p.slice(dir.length));
    byRoot.set(dir, rels);
  }
  const out = new Map<string, RouteInfo>();
  for (const [dir, rels] of byRoot) {
    const source = roots.get(dir)!;
    for (const found of READERS[source](rels)) {
      const info: RouteInfo = { ...found, file: dir + found.file, source };
      const had = out.get(info.path);
      // a page and an endpoint can answer the same path; the page is the one worth listing
      if (!had || (had.endpoint && !info.endpoint)) out.set(info.path, info);
    }
  }
  return [...out.values()].sort(byKind).slice(0, MAX_ROUTES);
}

/** places before templates, then by path in code-unit order, which no locale can reshuffle */
const byKind = (a: RouteInfo, b: RouteInfo) =>
  Number(a.dynamic) - Number(b.dynamic) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

const toPath = (segs: string[]) => `/${segs.join("/")}`;
const isGroup = (s: string) => /^\(.*\)$/.test(s);
const withoutIndex = (segs: string[]) => (segs.at(-1) === "index" ? segs.slice(0, -1) : segs);
const bracketed = (path: string) => path.includes("[");
const scriptExt = (ext: string | undefined) => ext === "ts" || ext === "js";

function next(rels: string[]): Found[] {
  const out: Found[] = [];
  for (const file of rels) {
    const app = file.match(/^(?:src\/)?app\/((?:[^/]+\/)*)(page|route)\.(?:tsx|jsx|ts|js|mdx)$/);
    if (app) {
      const segs = app[1]!.split("/").filter(Boolean);
      // a private folder is not routable, and an intercepting route stands in for a page listed elsewhere
      if (segs.some((s) => s.startsWith("_") || /^\(\.+\)/.test(s))) continue;
      const path = toPath(segs.filter((s) => !isGroup(s) && !s.startsWith("@")));
      out.push({ path, file, dynamic: bracketed(path), endpoint: app[2] === "route" });
      continue;
    }
    const pages = file.match(/^(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js|mdx)$/);
    if (!pages) continue;
    const segs = pages[1]!.split("/");
    // _app and _document frame every page, and the error pages are nowhere anyone navigates to
    if (segs.some((s) => s.startsWith("_")) || /^(404|500)$/.test(pages[1]!)) continue;
    const path = toPath(withoutIndex(segs));
    out.push({ path, file, dynamic: bracketed(path), endpoint: segs[0] === "api" });
  }
  return out;
}

function nuxt(rels: string[]): Found[] {
  const out: Found[] = [];
  for (const file of rels) {
    const m = file.match(/^(?:src\/|app\/)?pages\/(.+)\.vue$/);
    if (!m) continue;
    const path = toPath(withoutIndex(m[1]!.split("/").filter((s) => !isGroup(s))));
    out.push({ path, file, dynamic: bracketed(path), endpoint: false });
  }
  return out;
}

function sveltekit(rels: string[]): Found[] {
  const out: Found[] = [];
  for (const file of rels) {
    const m = file.match(/^src\/routes\/((?:[^/]+\/)*)\+(page|server)(?:@[^.]*)?\.(svelte|ts|js)$/);
    // a page is its .svelte file (the +page.ts beside it is its load), and an endpoint never is one
    if (!m || (m[2] === "page") !== (m[3] === "svelte")) continue;
    const path = toPath(m[1]!.split("/").filter((s) => s && !isGroup(s)));
    out.push({ path, file, dynamic: bracketed(path), endpoint: m[2] === "server" });
  }
  return out;
}

function astro(rels: string[]): Found[] {
  const out: Found[] = [];
  for (const file of rels) {
    const m = file.match(/^src\/pages\/(.+)\.(astro|md|mdx|html|ts|js)$/);
    if (!m) continue;
    const segs = m[1]!.split("/");
    if (segs.some((s) => s.startsWith("_"))) continue;
    const path = toPath(withoutIndex(segs));
    out.push({ path, file, dynamic: bracketed(path), endpoint: scriptExt(m[2]) });
  }
  return out;
}

function solid(rels: string[]): Found[] {
  const out: Found[] = [];
  for (const file of rels) {
    const m = file.match(/^src\/routes\/(.+)\.(tsx|jsx|ts|js|mdx)$/);
    if (!m) continue;
    const path = toPath(withoutIndex(m[1]!.split("/").filter((s) => !isGroup(s))));
    out.push({ path, file, dynamic: bracketed(path), endpoint: scriptExt(m[2]) });
  }
  return out;
}

function tanstack(rels: string[]): Found[] {
  const out: Found[] = [];
  for (const file of rels) {
    const m = file.match(/^(?:src\/|app\/)?routes\/(.+)\.(?:tsx|jsx|ts|js)$/);
    if (!m) continue;
    const parts = m[1]!.replace(/\.lazy$/, "").split("/");
    // a leading dash keeps a file beside the routes without making it one
    if (parts.some((s) => s.startsWith("-")) || parts.at(-1) === "__root") continue;
    const segs = parts
      .flatMap((s) => s.split("."))
      .filter((s, i, all) => !(i === all.length - 1 && (s === "index" || s === "route")))
      .filter((s) => !s.startsWith("_") && !isGroup(s))
      .map((s) => s.replace(/_$/, ""));
    const path = toPath(segs);
    out.push({ path, file, dynamic: path.includes("$"), endpoint: segs[0] === "api" });
  }
  return out;
}

function remix(rels: string[]): Found[] {
  // a route folder is its route file; anything else in it is a module that route imports
  const folders = rels.flatMap((f) => {
    const m = f.match(/^app\/routes\/(.+)\/route\.[jt]sx?$/);
    return m ? [m[1]!] : [];
  });
  const out: Found[] = [];
  for (const file of rels) {
    const m = file.match(/^app\/routes\/(.+)\.(tsx|jsx|ts|js|mdx|md)$/);
    if (!m) continue;
    let name = m[1]!;
    const cut = name.lastIndexOf("/");
    if (cut >= 0) {
      const dir = name.slice(0, cut);
      if (name.slice(cut + 1) === "route") name = dir;
      else if (folders.some((f) => dir === f || dir.startsWith(`${f}/`))) continue;
    }
    const segs = splitFlat(name).flatMap((s) => {
      // an index, and a pathless layout (a leading underscore), add no segment
      if (s === "index" || s.startsWith("_")) return [];
      const optional = /^\((.*)\)$/.exec(s);
      const bare = (optional ? optional[1]! : s).replace(/_$/, "").replace(/[[\]]/g, "");
      const seg = bare === "$" ? "*" : bare.startsWith("$") ? `:${bare.slice(1)}` : bare;
      return [optional ? `${seg}?` : seg];
    });
    const path = toPath(segs);
    out.push({ path, file, dynamic: /[:*]/.test(path), endpoint: scriptExt(m[2]) });
  }
  return out;
}

/** a flat route name's segments: dots and slashes separate them, except inside [ ], which escapes */
function splitFlat(name: string): string[] {
  const segs: string[] = [];
  let seg = "";
  let depth = 0;
  for (const ch of name) {
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "." || ch === "/")) {
      segs.push(seg);
      seg = "";
    } else seg += ch;
  }
  segs.push(seg);
  return segs.filter(Boolean);
}

const READERS: Record<RouteSource, (rels: string[]) => Found[]> = {
  next,
  nuxt,
  sveltekit,
  astro,
  solid,
  remix,
  tanstack,
};
