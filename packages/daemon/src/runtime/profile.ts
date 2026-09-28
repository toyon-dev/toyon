// Which procs a worktree runs and with what environment: the repo's config, narrowed by the
// worktree's profile, and split into what it runs itself and what it reaches on main. Pure so the
// registry's start path and the tests share one answer.

import type { RepoInfo, WorktreeInfo } from "@toyon/shared";
import { runCmd, runPaths, runShared } from "@toyon/shared";
import { log } from "../core/log.ts";

export interface ResolvedRun {
  /** name -> command, in start order: the whole set, borrowed procs included */
  procs: Record<string, string>;
  /** extra environment for every proc of the run (before `$VAR` expansion) */
  env: Record<string, string>;
  /** which proc the preview iframe shows */
  preview: string | undefined;
  /** the profile in effect, when the repo has profiles */
  profile: string | undefined;
  /** the shared tier: the procs marked `from: "trunk"`, in start order. Main runs these for
   * every worktree of the repo. */
  shared: string[];
  /** the shared procs this worktree reaches on main rather than running: the shared tier minus
   * what it owns; always empty on main */
  borrowed: string[];
  /** the paths each shared proc flips on, as written; a proc absent here infers them */
  paths: Record<string, string[]>;
}

/** the run of a worktree with nothing confirmed to run */
export const EMPTY_RUN: ResolvedRun = {
  procs: {},
  env: {},
  preview: undefined,
  profile: undefined,
  shared: [],
  borrowed: [],
  paths: {},
};

/** config.preview if it is one of the procs, else "web", else the first */
function previewOf(procs: Record<string, string>, preferred: string | undefined): string | undefined {
  if (preferred && preferred in procs) return preferred;
  return procs.web ? "web" : Object.keys(procs)[0];
}

export function resolveRun(repo: RepoInfo, wt: Pick<WorktreeInfo, "id" | "profile" | "kind" | "owns">): ResolvedRun {
  const cfg = repo.config;
  let names = Object.keys(cfg.run);
  let env: Record<string, string> = {};
  let profile: string | undefined;
  let preferred = cfg.preview;
  if (cfg.profiles && cfg.defaultProfile) {
    let name = wt.profile ?? cfg.defaultProfile;
    if (!(name in cfg.profiles)) {
      // the file changed under a running worktree: run the default rather than nothing
      log.warn(wt.id, `profile "${name}" is not in ${repo.configFile}; running "${cfg.defaultProfile}"`);
      name = cfg.defaultProfile;
    }
    const p = cfg.profiles[name]!;
    names = p.run.filter((n) => cfg.run[n] !== undefined);
    env = p.env ?? {};
    profile = name;
    preferred = p.preview ?? cfg.preview;
  }
  const procs: Record<string, string> = {};
  const shared: string[] = [];
  const paths: Record<string, string[]> = {};
  for (const n of names) {
    const entry = cfg.run[n]!;
    procs[n] = runCmd(entry);
    if (!runShared(entry)) continue;
    shared.push(n);
    const p = runPaths(entry);
    if (p) paths[n] = p;
  }
  const owns = new Set(wt.owns ?? []);
  const borrowed = wt.kind === "main" ? [] : shared.filter((n) => !owns.has(n));
  return { procs, env, preview: previewOf(procs, preferred), profile, shared, borrowed, paths };
}

/** `$VAR` / `${VAR}` in env values replaced from `vars` (the sibling-URL variables); references to
 * anything else stay as written, so a value meant for the shell to expand survives untouched */
export function expandEnv(env: Record<string, string>, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, a?: string, b?: string) => {
      const name = a ?? b ?? "";
      return name in vars ? vars[name]! : m;
    });
  }
  return out;
}
