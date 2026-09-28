// When a worktree that reaches the shared tier on main should run a proc of its own: the moment
// its changed files touch that proc. Watches every sign a file may have changed (a tool call
// ending, a turn settling, an editor save, the shell going quiet, a preview coming up), reads git
// once per burst, and hands the take-over to the service, which persists it and starts the proc.
// A take-over is one way: what a worktree runs itself stays its own until asked.

import { baseOf, type RepoInfo, SHELL_STREAM, type WorktreeInfo } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { committedFiles, statusFiles } from "../git/status.ts";
import { inferPaths, previewPaths } from "../repos/config.ts";
import { resolveRun } from "../runtime/profile.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";

/** files that change what every shared proc runs on: deps, env, containers */
export const ROOT_PATHS = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".env",
  ".env.*",
  "docker-compose*",
  "compose.*",
  "Dockerfile",
];
/** folders a migration lives in, anywhere in the tree: a migration means the api changed too */
export const MIGRATION_DIRS = ["migrations", "alembic", "prisma", "drizzle", "db/migrate", "supabase/migrations"];

/** the signals of one burst of edits are read once, after the last of them */
export const DEBOUNCE_MS = 150;
/** a shell that has printed nothing for this long has finished whatever it was doing */
export const SHELL_QUIET_MS = 1_500;

function matcher(patterns: string[]): (path: string) => boolean {
  const globs = patterns.map((p) => new Bun.Glob(p));
  return (path) => globs.some((g) => g.match(path));
}

export const rootMatch = matcher(ROOT_PATHS);
export const migrationMatch = matcher(MIGRATION_DIRS.flatMap((d) => [`${d}/**`, `**/${d}/**`]));

/** The changed file that calls for running a shared proc here, if any. `paths` are the proc's,
 * declared or inferred; a declared `[]` never flips. Deps, env, containers and migrations flip
 * every proc that can. A proc with no paths at all flips on anything outside the page. */
export function touching(files: string[], paths: string[], declared: boolean, pagePaths: string[]): string | undefined {
  if (declared && paths.length === 0) return undefined;
  const own = matcher(paths);
  const page = matcher(pagePaths);
  return files.find((f) => rootMatch(f) || migrationMatch(f) || (paths.length > 0 ? own(f) : !page(f)));
}

/** the worktree's changed files: uncommitted, and, when asked, committed ahead of main */
async function changedFiles(wt: WorktreeInfo, repo: RepoInfo, committed: boolean): Promise<string[]> {
  const files = new Set((await statusFiles(wt.path)).map((f) => f.path));
  if (committed) for (const f of await committedFiles(wt.path, baseOf(repo))) files.add(f.path);
  return [...files];
}

export interface BackendDeps {
  state: StateStore;
  hub: Hub;
  runtime: Pick<RuntimeRegistry, "borrows">;
  /** take the named procs over: the service persists `owns` and starts them */
  own: (worktreeId: string, names: string[]) => Promise<void>;
  /** the worktree's changed files; git when absent */
  changed?: (wt: WorktreeInfo, repo: RepoInfo, committed: boolean) => Promise<string[]>;
}

export class BackendShare {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private quiet = new Map<string, ReturnType<typeof setTimeout>>();
  /** whether the pending check should read the commits too, not only the status */
  private pending = new Map<string, boolean>();
  private running = new Set<string>();
  private again = new Set<string>();

  constructor(private d: BackendDeps) {
    d.hub.on("agent", (id, _seq, ev) => {
      if (ev.type === "tool-end") this.schedule(id, false);
    });
    // the commits are read at the edges where a commit could have landed: a turn's end, the shell
    // falling quiet; a tool ending mid-turn reads the status alone
    d.hub.on("turnSettled", (id) => this.schedule(id, true));
    d.hub.on("filesChanged", (id) => this.schedule(id, false));
    d.hub.on("termData", (id, stream) => {
      if (stream !== SHELL_STREAM) return;
      clearTimeout(this.quiet.get(id));
      this.quiet.set(
        id,
        setTimeout(() => {
          this.quiet.delete(id);
          this.schedule(id, true);
        }, SHELL_QUIET_MS),
      );
    });
    // a page coming up is a worktree born, claimed, woken or restored, and what it holds may
    // already touch the tier: a branch checked out onto the backend, a restore of one that did
    d.hub.on("proc", (id, p) => {
      if (p.status === "running") this.schedule(id, true);
    });
  }

  schedule(id: string, committed: boolean): void {
    if (!this.d.runtime.borrows(id)) return;
    this.pending.set(id, (this.pending.get(id) ?? false) || committed);
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        fireAndForget(id, this.run(id), "backend check");
      }, DEBOUNCE_MS),
    );
  }

  /** one check at a time per worktree; a signal during one means one more after it */
  private async run(id: string): Promise<void> {
    if (this.running.has(id)) {
      this.again.add(id);
      return;
    }
    this.running.add(id);
    try {
      do {
        this.again.delete(id);
        const committed = this.pending.get(id) ?? false;
        this.pending.delete(id);
        await this.check(id, committed);
      } while (this.again.has(id));
    } catch (e) {
      log.warn(id, "could not read what the worktree changed", e);
    } finally {
      this.running.delete(id);
    }
  }

  /** what the worktree's changes touch, and the take-over of every borrowed proc they touch */
  async check(id: string, committed = true): Promise<void> {
    const wt = this.d.state.worktree(id);
    if (!wt || wt.kind === "main" || !this.d.runtime.borrows(id)) return;
    const repo = this.d.state.requireRepo(wt.repoId);
    const run = resolveRun(repo, wt);
    if (run.borrowed.length === 0) return;
    const files = await (this.d.changed ?? changedFiles)(wt, repo, committed);
    if (files.length === 0) return;
    const page = run.preview ? previewPaths(run.procs[run.preview]!, repo.path) : [];
    const take: string[] = [];
    const why: string[] = [];
    for (const name of run.borrowed) {
      const declared = run.paths[name];
      const hit = touching(files, declared ?? inferPaths(run.procs[name]!, repo.path), declared !== undefined, page);
      if (hit) {
        take.push(name);
        why.push(hit);
      }
    }
    if (take.length === 0) return;
    log.info(id, `owns ${take.join(", ")}: changed ${why[0]}`);
    await this.d.own(id, take);
  }
}
