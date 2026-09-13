// Which procs a worktree runs and with what environment: the repo's config, narrowed by the
// worktree's profile. Pure so the registry's start path and the tests share one answer.

import type { RepoInfo, WorktreeInfo } from "@toyon/shared";
import { log } from "../core/log.ts";

export interface ResolvedRun {
  /** name -> command, in start order */
  procs: Record<string, string>;
  /** extra environment for every proc of the run (before `$VAR` expansion) */
  env: Record<string, string>;
  /** which proc the preview iframe shows */
  preview: string | undefined;
  /** the profile in effect, when the repo has profiles */
  profile: string | undefined;
}

/** config.preview if it is one of the procs, else "web", else the first */
function previewOf(procs: Record<string, string>, preferred: string | undefined): string | undefined {
  if (preferred && preferred in procs) return preferred;
  return procs.web ? "web" : Object.keys(procs)[0];
}

export function resolveRun(repo: RepoInfo, wt: Pick<WorktreeInfo, "id" | "profile">): ResolvedRun {
  const cfg = repo.config;
  if (!cfg.profiles || !cfg.defaultProfile) {
    return { procs: cfg.run, env: {}, preview: previewOf(cfg.run, cfg.preview), profile: undefined };
  }
  let name = wt.profile ?? cfg.defaultProfile;
  if (!(name in cfg.profiles)) {
    // the file changed under a running worktree: run the default rather than nothing
    log.warn(wt.id, `profile "${name}" is not in ${repo.configFile}; running "${cfg.defaultProfile}"`);
    name = cfg.defaultProfile;
  }
  const profile = cfg.profiles[name]!;
  const procs: Record<string, string> = {};
  for (const p of profile.run) {
    if (cfg.run[p] !== undefined) procs[p] = cfg.run[p]!;
  }
  return {
    procs,
    env: profile.env ?? {},
    preview: previewOf(procs, profile.preview ?? cfg.preview),
    profile: name,
  };
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
