import { join } from "node:path";
import { cleanTitle, type PageEntry, type RouteInfo, routeKey } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { git } from "../git/exec.ts";
import type { ReadableWorktree } from "../worktrees/service.ts";
import { fileRoutes, frameworksOf, isManifest, type Manifest } from "./fileRouters.ts";
import { bump, entries, retitle } from "./frecency.ts";

/** state.json is written whole and synchronously, and a page that rewrites its address as it
 * scrolls would otherwise have it written on every scroll. A crash loses at most this much. */
const SAVE_DELAY_MS = 5000;
/** The list opened twice in a row asks once; a page the agent just added shows on the next open. */
const SCAN_MEMO_MS = 5000;
/** manifests read per scan: a monorepo has a handful, and a vendored tree is not a project */
const MAX_MANIFESTS = 50;

export interface RouteDeps {
  state: StateStore;
  hub: Hub;
  /** worktrees toyon found on disk run previews too, and the store has no record of them */
  readable: (id: string) => ReadableWorktree | null;
  now?: () => number;
  saveDelayMs?: number;
}

/** what the shell's list would show: order and titles. A score that moved and reordered nothing is
 * not news, since decay scales every score alike */
const signatureOf = (list: PageEntry[]) => list.map((e) => `${e.path}\t${e.title ?? ""}`).join("\n");

/** The route bar's list: which preview pages each project is used on, counted per repo rather than
 * per worktree so a new worktree starts out knowing the pages you already use, and the pages a
 * worktree's own files define, read off its file layout. */
export class RouteService {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** the list last announced per repo, so a visit that leaves order and titles alone broadcasts nothing */
  private announced = new Map<string, string>();
  /** each worktree's last scan, kept briefly; the promise itself, so a second ask joins one in flight */
  private scans = new Map<string, { at: number; routes: Promise<RouteInfo[]> }>();

  constructor(private d: RouteDeps) {}

  /** A preview settled on a page. An id nobody knows is dropped rather than refused: the frame may
   * belong to a worktree removed a moment ago, and a toast on every navigation would be noise. */
  visit(worktreeId: string, path: string, title?: string): void {
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

  /** the pages this worktree's files define, for the routers that read them off the file layout */
  async files(worktreeId: string): Promise<RouteInfo[]> {
    const wt = this.d.readable(worktreeId);
    if (!wt) throw new UserError("unknown worktree");
    const now = this.now();
    const hit = this.scans.get(worktreeId);
    if (hit && now - hit.at < SCAN_MEMO_MS) return hit.routes;
    const routes = this.scan(wt.path);
    this.scans.set(worktreeId, { at: now, routes });
    return routes;
  }

  /** write what is waiting, now: the daemon is going down */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.d.state.save();
  }

  /** never rejects: a worktree whose files cannot be listed has no routes to offer, not an error */
  private async scan(root: string): Promise<RouteInfo[]> {
    const listed = await git(root, "ls-files", "-co", "--exclude-standard");
    if (!listed.ok) {
      log.warn("routes", `could not list the files in ${root}: ${listed.err}`);
      return [];
    }
    const paths = listed.out.split("\n").filter(Boolean);
    const manifests: Manifest[] = [];
    for (const p of paths.filter(isManifest).slice(0, MAX_MANIFESTS)) {
      try {
        const pkg = JSON.parse(await Bun.file(join(root, p)).text()) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        manifests.push({
          dir: p.slice(0, -"package.json".length),
          deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }),
        });
      } catch (e) {
        // a manifest that does not parse names no router, and a config file beside it still can
        log.debug("routes", `${p} did not parse`, e);
      }
    }
    return fileRoutes(paths, frameworksOf(paths, manifests));
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
