// What a copy builds that the next copy can start from: `cache` in the repo's settings names the
// paths (node_modules, .mypy_cache, .testmondata), and an entry is keyed by the lockfiles, the
// tool versions, the platform and the commit the copy was cut from. The hashing reads the
// machine, so the daemon owns it (worktrees/cache.ts); this file holds the shape the settings
// pane and the daemon read the same way.

import type { CacheConfig, ToyonConfig } from "./model.ts";

export interface CachePolicy {
  paths: string[];
  /** files under the root whose contents key the entries, beside the lockfiles */
  key: string[];
  /** commands whose output keys the entries; absent means infer them from the lockfiles present */
  tools?: string[];
}

/** the paths and the key a repo caches by, or null when the settings name nothing */
export function cachePolicy(config: Pick<ToyonConfig, "cache">): CachePolicy | null {
  const c = config.cache;
  if (!c) return null;
  const cfg: CacheConfig = Array.isArray(c) ? { paths: c } : c;
  if (cfg.paths.length === 0) return null;
  return { paths: cfg.paths, key: cfg.key ?? [], ...(cfg.tools ? { tools: cfg.tools } : {}) };
}

/** why a path cannot be cached, or undefined for one that can: relative, inside the root, and
 * not git's own directory, since a clone of that into a worktree is a second repo */
export function cachePathReason(p: string): string | undefined {
  if (!p || p !== p.trim()) return "must be a path";
  if (p.startsWith("/") || p.startsWith("~")) return "must be relative to the root";
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return "must stay inside the root";
  if (parts[0] === ".git") return "cannot name .git";
  return undefined;
}

/** The files a SQLite database keeps beside itself: pages committed but not yet in the main file
 * (`-wal`) and a rollback journal. They travel with the file, since the file alone is behind
 * them; `-shm` stays, being an index the next open rebuilds. */
export const SIDECARS = ["-wal", "-journal"] as const;
