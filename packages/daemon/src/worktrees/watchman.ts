// Watchman keeps a watch, and the file tree it read for it, after the watched directory is gone.
// Jest registers one for every checkout it runs in, so a machine where worktrees come and go all
// day collects a tree in memory per worktree that ever ran a test: 14 watches held 15 GB on one.
// Toyon is the one that knows when a worktree's directory went, so it tells watchman.
//
// Best effort throughout: no watchman is the common case, and nothing here is worth a warning or
// a wait.

import { existsSync } from "node:fs";
import { canonical, within } from "../agent/bounds.ts";
import { log } from "../core/log.ts";
import { run } from "../git/exec.ts";

/** Ahead of every command. `--no-spawn`: the client starts a server when none answers, and a
 * server nobody asked for is the memory this exists to give back. `--no-local`: without it a
 * client that finds no server answers the command itself, from a state of its own with no watch
 * in it. Every watchman since 4.9 takes both. */
const NO_SERVER = ["--no-spawn", "--no-local"];

/** both commands answer from the server's memory; one that has not by now is not going to */
const TIMEOUT_MS = 5_000;

export interface WatchmanDeps {
  /** toyon's worktrees root: a watch anywhere else is somebody else's and is never touched */
  root: string;
  run?: typeof run;
  which?: (cmd: string) => string | null;
}

export class WatchmanWatches {
  /** the binary, looked up once per daemon run: null on a machine with none, which then costs
   * nothing per removal */
  private bin: string | null | undefined;

  constructor(private d: WatchmanDeps) {}

  /** A worktree's directory went: its watch goes, and any on a folder inside it. Nothing while
   * the directory stands, since a watch on a live tree is somebody's. */
  async drop(path: string): Promise<void> {
    if (existsSync(path)) return;
    // the roots are real paths, and the directory is no longer there to resolve
    const gone = canonical(path);
    if (!within(gone, canonical(this.d.root))) return;
    await this.del((root) => within(root, gone));
  }

  /** Once at boot: the watches earlier daemons left on directories that are gone. */
  async sweep(): Promise<void> {
    await this.del((root) => !existsSync(root));
  }

  private async del(dead: (root: string) => boolean): Promise<void> {
    const home = canonical(this.d.root);
    let dropped = 0;
    for (const root of await this.roots()) {
      if (root === home || !within(root, home) || !dead(root)) continue;
      // a watch that went meanwhile answers with an error, which is the outcome wanted
      if ((await this.ask("watch-del", root))?.ok) dropped++;
    }
    if (dropped > 0)
      log.info("watchman", `dropped ${dropped} ${dropped === 1 ? "watch" : "watches"} whose worktree is gone`);
  }

  /** every root the running server watches; none when no server is running */
  private async roots(): Promise<string[]> {
    const r = await this.ask("watch-list");
    if (!r?.ok) return [];
    try {
      const roots: unknown = JSON.parse(r.out).roots;
      return Array.isArray(roots) ? roots.filter((p): p is string => typeof p === "string") : [];
    } catch {
      // not the list, so nothing here names a watch to drop
      return [];
    }
  }

  private async ask(...command: string[]) {
    if (this.bin === undefined) this.bin = (this.d.which ?? Bun.which)("watchman");
    if (!this.bin) return null;
    return (this.d.run ?? run)(this.bin, [...NO_SERVER, ...command], this.d.root, undefined, { timeoutMs: TIMEOUT_MS });
  }
}
