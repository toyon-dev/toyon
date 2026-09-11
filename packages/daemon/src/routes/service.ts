import { join } from "node:path";
import {
  cleanTitle,
  compileRoute,
  type GitFileStatus,
  type PageEntry,
  type RouteInfo,
  routeKey,
  type Template,
  templateFor,
  type WorktreePages,
} from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { git } from "../git/exec.ts";
import type { ReadableWorktree } from "../worktrees/service.ts";
import { fileRoutes, frameworksOf, isManifest, isSkipped, type Manifest, mergeRoutes } from "./fileRouters.ts";
import { bump, entries, retitle } from "./frecency.ts";
import { ROUTER_MARKER, reactRoutes, type SourceFile } from "./reactRouter.ts";
import { badgeCandidates, unseenOf } from "./seen.ts";

/** state.json is written whole and synchronously, and a page that rewrites its address as it
 * scrolls would otherwise have it written on every scroll. A crash loses at most this much. */
const SAVE_DELAY_MS = 5000;
/** manifests read per scan: a monorepo has a handful, and a vendored tree is not a project */
const MAX_MANIFESTS = 50;
/** worktrees whose scan is kept between pushes; the one on screen is always among them */
const SCAN_CACHE = 20;
/** changed page files hashed per push; the list shows eight badges at most */
const MAX_HASHED = 64;
/** a file larger than this is judged by its size and time rather than read whole */
const HASH_WHOLE_BYTES = 1024 * 1024;
/** page files remembered per worktree */
const SEEN_FILES = 500;
/** script files a React Router app may declare routes in, per root */
const MAX_CODE_FILES = 3000;
/** past this a script file is generated or vendored, not a route table */
const MAX_CODE_BYTES = 400 * 1024;
const CODE_FILE = /\.(tsx|jsx|ts|js|mts)$/;
const NOT_ROUTES = /\.(test|spec|stories)\.|\.d\.ts$/;

/** how the service reads the worktree's files, so a test can count the reads */
export interface RouteFs {
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  read(path: string): Promise<Uint8Array | null>;
}

const bunFs: RouteFs = {
  async stat(path) {
    try {
      const s = await Bun.file(path).stat();
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      // a file git listed can be gone a moment later: absent is the answer, not an error
      return null;
    }
  },
  async read(path) {
    try {
      return new Uint8Array(await Bun.file(path).arrayBuffer());
    } catch {
      // as above: gone, or unreadable, reads as absent
      return null;
    }
  },
};

/** the changed files a worktree's git status carries */
export type WorktreeGit = { files: GitFileStatus[]; committed?: GitFileStatus[] };

export interface RouteDeps {
  state: StateStore;
  hub: Hub;
  /** worktrees toyon found on disk run previews too, and the store has no record of them */
  readable: (id: string) => ReadableWorktree | null;
  fs?: RouteFs;
  now?: () => number;
  saveDelayMs?: number;
}

/** a file read before, and what it held, kept until its size or time moves */
type Cached<T> = { sig: string; value: T };

/** one worktree's scan and what was last sent from it */
interface Scan {
  root: string;
  inflight: Promise<RouteInfo[]> | null;
  /** a push arrived while a scan ran: run once more after it */
  rerun: boolean;
  routes: RouteInfo[] | null;
  templates: Template[];
  /** each manifest's dependencies */
  manifests: Map<string, Cached<string[] | null>>;
  /** each script file's text, for the ones that name a router; null for the rest */
  code: Map<string, Cached<string | null>>;
  git: WorktreeGit | null;
  pages: WorktreePages | null;
}

/** what the shell's list would show: order and titles. A score that moved and reordered nothing is
 * not news, since decay scales every score alike */
const signatureOf = (list: PageEntry[]) => list.map((e) => `${e.path}\t${e.title ?? ""}`).join("\n");

/** The route bar's list: which preview pages each project is used on, counted per repo so a new
 * worktree starts out knowing the pages you already use; the pages a worktree's own files define,
 * read off its file layout or its React Router code; and which of those changed since you last had
 * them open there. */
export class RouteService {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** the list last announced per repo, so a visit that leaves order and titles alone broadcasts nothing */
  private announced = new Map<string, string>();
  /** per worktree, most recently used last */
  private scans = new Map<string, Scan>();

  constructor(private d: RouteDeps) {}

  /** A preview settled on a page. An id nobody knows is dropped rather than refused: the frame may
   * belong to a worktree removed a moment ago, and a toast on every navigation would be noise. */
  async visit(worktreeId: string, path: string, title?: string): Promise<void> {
    const repoId = this.repoOf(worktreeId);
    if (!repoId) {
      log.warn("routes", `a visit from unknown worktree ${worktreeId} was dropped`);
      return;
    }
    const key = routeKey(path);
    if (!key) return;
    const before = this.signature(repoId);
    bump(this.d.state.visitsFor(repoId), key, this.now(), cleanTitle(title));
    this.changed(repoId, before);
    await this.stamp(worktreeId, repoId, key);
  }

  /** A page's title settled after its visit was counted: an app names its page a tick or a fetch
   * after it gets there. Renames without counting; a page not on the list is left off it. */
  retitle(worktreeId: string, path: string, title: string): void {
    const repoId = this.repoOf(worktreeId);
    const key = routeKey(path);
    const named = cleanTitle(title);
    const pages = repoId ? this.d.state.visitsOf(repoId) : undefined;
    // the same quiet drop as a visit's: a title for a worktree that has gone is nobody's mistake
    if (!repoId || !key || !named || !pages) return;
    const before = this.signature(repoId);
    if (retitle(pages, key, named)) this.changed(repoId, before);
  }

  /** take a page off a repo's list */
  forget(repoId: string, path: string): void {
    this.d.state.requireRepo(repoId);
    const key = routeKey(path);
    const pages = this.d.state.visitsOf(repoId);
    if (!key || !pages?.[key]) return;
    const before = this.signature(repoId);
    delete pages[key];
    this.changed(repoId, before);
  }

  /** a repo's remembered pages, best first, as the shell is sent them */
  history(repoId: string): PageEntry[] {
    const pages = this.d.state.visitsOf(repoId);
    return pages ? entries(pages, this.now()) : [];
  }

  /** every registered repo's history that has anything in it, for hello */
  historyAll(): Record<string, PageEntry[]> {
    const out: Record<string, PageEntry[]> = {};
    for (const r of this.d.state.repos) {
      const list = this.history(r.id);
      if (list.length > 0) out[r.id] = list;
    }
    return out;
  }

  /** A worktree's pages with their badges, for its git status as it stands. Scans, or joins a scan
   * already running, and reads only the files that moved since the last one. */
  async pages(worktreeId: string, git: WorktreeGit): Promise<WorktreePages> {
    const wt = this.d.readable(worktreeId);
    if (!wt) return { routes: [], unseen: {} };
    const scan = this.scanFor(worktreeId, wt.path);
    await this.routesOf(scan);
    scan.git = git;
    await this.refreshUnseen(worktreeId, scan);
    return scan.pages ?? { routes: [], unseen: {} };
  }

  /** the pages last worked out for a worktree, after a visit may have moved its badges */
  cached(worktreeId: string): WorktreePages | null {
    return this.scans.get(worktreeId)?.pages ?? null;
  }

  /** write what is waiting, now: the daemon is going down */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.d.state.save();
  }

  /** The page just opened becomes the one on screen, and both it and the page left behind are
   * remembered as they stand now: a page you watched change is not news afterwards. */
  private async stamp(worktreeId: string, repoId: string, key: string): Promise<void> {
    const scan = this.scans.get(worktreeId);
    // never subscribed, so never scanned: there are no badges to move
    if (!scan?.routes) return;
    const file = this.fileFor(scan, key);
    const rec = this.d.state.seenFor(worktreeId, repoId, this.now());
    for (const f of new Set([rec.here, file])) {
      if (!f) continue;
      const hash = await this.hash(scan.root, f);
      // re-inserted, so the files remembered longest ago are the first to go past the cap
      delete rec.files[f];
      if (hash) rec.files[f] = hash;
    }
    if (file) rec.here = file;
    else delete rec.here;
    const kept = Object.keys(rec.files);
    for (const f of kept.slice(0, Math.max(0, kept.length - SEEN_FILES))) delete rec.files[f];
    this.scheduleSave();
    if (await this.refreshUnseen(worktreeId, scan)) this.d.hub.emit("pagesChanged", worktreeId);
  }

  /** the file behind a page: its own route's, else the most particular template it falls under */
  private fileFor(scan: Scan, key: string): string | null {
    const routes = scan.routes ?? [];
    const exact = routes.find((r) => !r.dynamic && r.path === key);
    if (exact) return exact.file;
    const t = templateFor(scan.templates, key);
    return (t && routes.find((r) => r.path === t.path)?.file) ?? null;
  }

  /** work out the badges again; true when they moved */
  private async refreshUnseen(worktreeId: string, scan: Scan): Promise<boolean> {
    if (!scan.routes) return false;
    const changed = scan.git ? [...scan.git.files, ...(scan.git.committed ?? [])] : [];
    const seen = this.d.state.seenOf(worktreeId);
    const candidates = badgeCandidates(scan.routes, changed, seen?.here).slice(0, MAX_HASHED);
    const hashes: Record<string, string> = {};
    for (const f of candidates) {
      const h = await this.hash(scan.root, f.path);
      if (h) hashes[f.path] = h;
    }
    const next: WorktreePages = { routes: scan.routes, unseen: unseenOf(candidates, seen, hashes) };
    const moved =
      !scan.pages ||
      scan.pages.routes !== next.routes ||
      JSON.stringify(scan.pages.unseen) !== JSON.stringify(next.unseen);
    scan.pages = next;
    return moved;
  }

  private scanFor(worktreeId: string, root: string): Scan {
    const had = this.scans.get(worktreeId);
    const scan: Scan = had ?? {
      root,
      inflight: null,
      rerun: false,
      routes: null,
      templates: [],
      manifests: new Map(),
      code: new Map(),
      git: null,
      pages: null,
    };
    scan.root = root;
    this.scans.delete(worktreeId);
    this.scans.set(worktreeId, scan);
    for (const id of this.scans.keys()) {
      if (this.scans.size <= SCAN_CACHE) break;
      this.scans.delete(id);
    }
    return scan;
  }

  /** one scan per worktree at a time; a push during a scan runs it once more rather than twice over */
  private routesOf(scan: Scan): Promise<RouteInfo[]> {
    if (scan.inflight) {
      scan.rerun = true;
      return scan.inflight;
    }
    const run = async (): Promise<RouteInfo[]> => {
      do {
        scan.rerun = false;
        const routes = await this.scan(scan);
        scan.routes = routes;
        scan.templates = routes.flatMap((r) => {
          const t = compileRoute(r.path);
          return t ? [t] : [];
        });
      } while (scan.rerun);
      return scan.routes ?? [];
    };
    scan.inflight = run().finally(() => {
      scan.inflight = null;
    });
    return scan.inflight;
  }

  /** never rejects: a worktree whose files cannot be listed has no routes to offer, not an error */
  private async scan(scan: Scan): Promise<RouteInfo[]> {
    const listed = await git(scan.root, "ls-files", "-co", "--exclude-standard");
    if (!listed.ok) {
      log.warn("routes", `could not list the files in ${scan.root}: ${listed.err}`);
      return [];
    }
    const paths = listed.out.split("\n").filter(Boolean);
    const manifests: Manifest[] = [];
    const keptManifests = new Map<string, Cached<string[] | null>>();
    for (const p of paths.filter(isManifest).slice(0, MAX_MANIFESTS)) {
      const deps = await this.cachedRead(scan.root, p, scan.manifests, keptManifests, (bytes) => this.depsOf(bytes, p));
      if (deps) manifests.push({ dir: p.slice(0, -"package.json".length), deps });
    }
    scan.manifests = keptManifests;
    const roots = frameworksOf(paths, manifests);
    const code: RouteInfo[] = [];
    const keptCode = new Map<string, Cached<string | null>>();
    for (const [dir, source] of roots) {
      if (source !== "react-router") continue;
      const under = paths
        .filter((p) => p.startsWith(dir) && CODE_FILE.test(p) && !NOT_ROUTES.test(p) && !isSkipped(p))
        .slice(0, MAX_CODE_FILES);
      const files: SourceFile[] = [];
      for (const p of under) {
        const text = await this.cachedRead(scan.root, p, scan.code, keptCode, (bytes) => {
          if (bytes.length > MAX_CODE_BYTES) return null;
          const text = new TextDecoder().decode(bytes);
          return ROUTER_MARKER.test(text) ? text : null;
        });
        if (text !== null) files.push({ path: p.slice(dir.length), text });
      }
      const rel = under.map((p) => p.slice(dir.length));
      for (const r of reactRoutes(files, rel)) code.push({ ...r, file: dir + r.file, source });
    }
    scan.code = keptCode;
    return mergeRoutes(fileRoutes(paths, roots), code);
  }

  /** a file's reading, from the cache while its size and time hold, else read afresh */
  private async cachedRead<T>(
    root: string,
    path: string,
    had: Map<string, Cached<T | null>>,
    kept: Map<string, Cached<T | null>>,
    decode: (bytes: Uint8Array) => T | null,
  ): Promise<T | null> {
    const abs = join(root, path);
    const stat = await this.fs.stat(abs);
    if (!stat) return null;
    const sig = `${stat.mtimeMs}:${stat.size}`;
    const hit = had.get(path);
    if (hit?.sig === sig) {
      kept.set(path, hit);
      return hit.value;
    }
    const bytes = await this.fs.read(abs);
    const value = bytes ? decode(bytes) : null;
    kept.set(path, { sig, value });
    return value;
  }

  private depsOf(bytes: Uint8Array, p: string): string[] | null {
    try {
      const pkg = JSON.parse(new TextDecoder().decode(bytes)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    } catch (e) {
      // a manifest that does not parse names no router, and a config file beside it still can
      log.debug("routes", `${p} did not parse`, e);
      return null;
    }
  }

  /** what a file holds, as a short hash; a very large one is judged by its size and time */
  private async hash(root: string, file: string): Promise<string | null> {
    const abs = join(root, file);
    const stat = await this.fs.stat(abs);
    if (!stat) return null;
    if (stat.size > HASH_WHOLE_BYTES) return `${stat.size}:${stat.mtimeMs}`;
    const bytes = await this.fs.read(abs);
    return bytes ? Bun.hash(bytes).toString(36) : null;
  }

  private get fs(): RouteFs {
    return this.d.fs ?? bunFs;
  }

  private changed(repoId: string, before: string): void {
    this.scheduleSave();
    const after = signatureOf(this.history(repoId));
    this.announced.set(repoId, after);
    if (after !== before) this.d.hub.emit("visitsChanged", repoId);
  }

  private signature(repoId: string): string {
    return this.announced.get(repoId) ?? signatureOf(this.history(repoId));
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // a timer has no caller to hand a failed write to; the next visit tries again
      try {
        this.d.state.save();
      } catch (e) {
        log.error("routes", "could not write the page lists", e);
      }
    }, this.d.saveDelayMs ?? SAVE_DELAY_MS);
    // a write still waiting must not hold a test run, or a daemon that is otherwise done, open
    this.saveTimer.unref();
  }

  private repoOf(worktreeId: string): string | null {
    // the store's own records first, spares included, since a draft previews in one
    return this.d.state.worktree(worktreeId)?.repoId ?? this.d.readable(worktreeId)?.repoId ?? null;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }
}
