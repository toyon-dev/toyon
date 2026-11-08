// Which procs a worktree runs, which it reaches on main, and which its page points away from: its
// settings (its own file, else the repo's) and the repo's shared tier, read against the worktree's
// record. Pure so the registry's start path, the flip, the tool and the tests share one answer.

import type { TierProc, WorktreeInfo } from "@toyon/shared";
import { ownedBy, previewProc, remoteOf, runCmd, runRemotes } from "@toyon/shared";
import { log } from "../core/log.ts";
import type { WorktreeConfig } from "../repos/config.ts";

export interface ResolvedRun {
  /** name -> command, in config order: the whole set, borrowed and pointed procs included */
  procs: Record<string, string>;
  /** which proc the preview iframe shows */
  preview: string | undefined;
  /** the shared tier as it reaches this worktree: the procs main runs for every worktree of the
   * repo that this worktree's own file names too, in config order */
  shared: string[];
  /** the shared procs this worktree reaches on main rather than running: the tier minus what it
   * runs itself and what it points away; always empty on main */
  borrowed: string[];
  /** proc -> the remote URL this worktree's page reaches instead of main's or its own, for the
   * procs the record points at a remote the file still names; always empty on main */
  pointed: Record<string, string>;
  /** the globs each shared proc flips on, from the tier */
  paths: Record<string, string[]>;
}

/** the run of a worktree with nothing confirmed to run */
export const EMPTY_RUN: ResolvedRun = {
  procs: {},
  preview: undefined,
  shared: [],
  borrowed: [],
  pointed: {},
  paths: {},
};

/** `tier` is what main runs for everyone, settled from the repo's file and main's tree: a proc the
 * worktree's own file names is borrowed only when main has one by that name to reach, and runs
 * here otherwise, since a forwarder with no proc behind it would hang the page on a server nobody
 * started. */
export function resolveRun(
  { config: cfg, file }: WorktreeConfig,
  wt: Pick<WorktreeInfo, "id" | "kind" | "sources">,
  tier: Record<string, TierProc>,
): ResolvedRun {
  const names = Object.keys(cfg.run);
  const procs: Record<string, string> = {};
  for (const n of names) procs[n] = runCmd(cfg.run[n]!);
  const shared = names.filter((n) => tier[n] !== undefined);
  const paths: Record<string, string[]> = {};
  for (const n of shared) paths[n] = tier[n]!.paths;
  const pointed: Record<string, string> = {};
  const owned = new Set<string>();
  if (wt.kind !== "main") {
    for (const [name, src] of Object.entries(wt.sources ?? {})) {
      const entry = cfg.run[name];
      if (entry === undefined) continue;
      const remote = remoteOf(src.at);
      if (remote !== undefined) {
        const url = runRemotes(entry)[remote];
        if (url) pointed[name] = url;
        // the file lost the remote under a pointed worktree: main's is the one address that is there
        else log.warn(wt.id, `"${name}" has no remote "${remote}" in ${file}; reaching it on main`);
      } else if (ownedBy(src.at)) owned.add(name);
    }
  }
  const borrowed = wt.kind === "main" ? [] : shared.filter((n) => !owned.has(n) && !(n in pointed));
  return { procs, preview: previewProc(names, cfg.preview), shared, borrowed, pointed, paths };
}

/** why a take-over happens: a person pressed, the agent asked ahead of an edit, or the worktree's
 * changes touched the procs (the changed file per proc) */
export type OwnWhy = { by: "hand" } | { by: "agent" } | { by: "edit"; files: Record<string, string> };

/** the procs the worktree spawns itself: everything but what it borrows and what it points away */
export function spawnsOf(run: ResolvedRun): string[] {
  return Object.keys(run.procs).filter((n) => !run.borrowed.includes(n) && !(n in run.pointed));
}
