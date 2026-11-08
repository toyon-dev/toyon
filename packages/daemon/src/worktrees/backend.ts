// When a worktree that reaches the shared tier on main should run a proc of its own: the moment
// its changed files touch that proc. Watches every sign a file may have changed (a tool call
// ending, a turn settling, an editor save, the shell going quiet, a preview coming up), reads git
// once per burst, and hands the take-over to the service, which persists it and starts the proc.
// A take-over is one way: what a worktree runs itself stays its own until asked. A proc the page
// points at a remote is never taken over, since the pick was a person's; its touched files are
// marked instead, so the chip can say the page is not talking to them.

import { baseOf, type ProcSource, type RepoInfo, SHELL_STREAM, type WorktreeInfo } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { committedFiles, statusFiles } from "../git/status.ts";
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

/** The changed files that call for running a shared proc here, in the order given. `paths` are
 * the proc's, written or inferred; deps, env, containers and migrations flip every proc that has
 * some. A proc with none has nothing of its own to rebuild, so no change flips it. */
export function touched(files: string[], paths: string[]): string[] {
  if (paths.length === 0) return [];
  const own = matcher(paths);
  return files.filter((f) => rootMatch(f) || migrationMatch(f) || own(f));
}

/** the first of `touched`, if any */
export function touching(files: string[], paths: string[]): string | undefined {
  return touched(files, paths)[0];
}

/** The touching files a person has not seen since moving the proc back to main's by hand: all of
 * them with no hold on the record, else those outside the hold. A hold is a pick made knowing the
 * files as they stood, so the same files flip nothing; a file newly touching does. */
export function unheld(hits: string[], src: ProcSource | undefined): string[] {
  const held = src?.held;
  return held ? hits.filter((f) => !held.includes(f)) : hits;
}

/** the worktree's changed files: uncommitted, and, when asked, committed ahead of main */
export async function changedFiles(wt: WorktreeInfo, repo: RepoInfo, committed: boolean): Promise<string[]> {
  const files = new Set((await statusFiles(wt.path)).map((f) => f.path));
  if (committed) for (const f of await committedFiles(wt.path, baseOf(repo))) files.add(f.path);
  return [...files];
}

export interface BackendDeps {
  state: StateStore;
  hub: Hub;
  runtime: Pick<RuntimeRegistry, "borrows" | "points" | "markRemoteBehind" | "runOf">;
  /** take the named procs over, with the changed file that called for each: the service persists
   * the record and starts them */
  own: (worktreeId: string, names: string[], files: Record<string, string>) => Promise<void>;
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

  /** whether the worktree has anything the check could move: a borrowed proc, or a pointed one */
  private watched(id: string): boolean {
    return this.d.runtime.borrows(id) || this.d.runtime.points(id);
  }

  schedule(id: string, committed: boolean): void {
    if (!this.watched(id)) return;
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

  /** what the worktree's changes touch: the take-over of every borrowed proc they touch, and the
   * mark on every pointed one */
  async check(id: string, committed = true): Promise<void> {
    const wt = this.d.state.worktree(id);
    if (!wt || wt.kind === "main" || !this.watched(id)) return;
    const repo = this.d.state.requireRepo(wt.repoId);
    // the run the procs came up under, so the take-over starts the command its siblings run with
    const run = this.d.runtime.runOf(id);
    if (!run) return;
    const pointed = Object.keys(run.pointed);
    if (run.borrowed.length === 0 && pointed.length === 0) return;
    const files = await (this.d.changed ?? changedFiles)(wt, repo, committed);
    if (files.length === 0) {
      this.d.runtime.markRemoteBehind(id, []);
      return;
    }
    const take: string[] = [];
    const why: Record<string, string> = {};
    const behind: string[] = [];
    for (const name of [...run.borrowed, ...pointed]) {
      const tier = repo.tier?.[name];
      if (!tier) continue;
      const hits = touched(files, tier.paths);
      if (hits.length === 0) continue;
      if (name in run.pointed) behind.push(name);
      else {
        // a borrowed proc a person moved back to main's by hand stays main's on the files they
        // moved it over; the file that flips it is one they have not seen
        const [hit] = unheld(hits, wt.sources?.[name]);
        if (!hit) continue;
        take.push(name);
        why[name] = hit;
      }
    }
    this.d.runtime.markRemoteBehind(id, behind);
    if (take.length === 0) return;
    log.info(id, `owns ${take.join(", ")}: changed ${why[take[0]!]}`);
    await this.d.own(id, take, why);
  }
}
