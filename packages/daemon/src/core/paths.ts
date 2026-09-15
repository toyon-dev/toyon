// Where the daemon keeps its state. Built once in index.ts and passed to everything that touches
// disk, so tests can each use a throwaway home (and nothing reads the env at import time).

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_FILES } from "@toyon/shared";

export interface Paths {
  home: string;
  stateFile: string;
  /** the unsent text in every composer box (drafts/store.ts) */
  draftsFile: string;
  tokenFile: string;
  /** the running daemon's pid, for `toyon stop`; absent or stale when it is not running */
  pidFile: string;
  /** where a detached daemon's own output goes: what `toyon logs` reads, and what a daemon
   * restarting itself points its replacement at (core/restart.ts) */
  logFile: string;
  /** the name a TLS front answers for, written by `toyon remote` (core/remote.ts) */
  remoteFile: string;
  transcriptsDir: string;
  /** images attached to chat messages, by worktree id (agent/attachments.ts) */
  attachmentsDir: string;
  /** removed worktrees: each one's record, transcript and attachments (worktrees/archive.ts) */
  archiveDir: string;
  worktreesDir: string;
  /** user-dropped theme files: Toyon Theme JSON or raw VS Code theme JSON/JSONC */
  themesDir: string;
  /** one npm install per agent adapter (<id>/node_modules/...), fetched on demand */
  agentsDir: string;
  /** the user's own ACP agents (agent/registry.ts); commands the daemon runs, so no agent touches it */
  agentsFile: string;
  /** where an agent runs with no worktree behind it (a model probe, a sign-out), confined like any other */
  scratchDir: string;
  /** git's credential store on a machine given a GitHub token (the cloud entrypoint writes it); a
   * secret the daemon's own git reads and no agent may */
  gitCredentialsFile: string;
}

/** TOYON_HOME lets cloud mode keep state on a mounted volume (see core/cloud.ts) */
export function makePaths(home = process.env.TOYON_HOME ?? join(homedir(), ".toyon")): Paths {
  return {
    home,
    stateFile: join(home, DAEMON_FILES.state),
    draftsFile: join(home, DAEMON_FILES.drafts),
    tokenFile: join(home, DAEMON_FILES.token),
    pidFile: join(home, DAEMON_FILES.pid),
    logFile: join(home, DAEMON_FILES.log),
    remoteFile: join(home, DAEMON_FILES.remote),
    transcriptsDir: join(home, "transcripts"),
    attachmentsDir: join(home, "attachments"),
    archiveDir: join(home, "archive"),
    // `.noindex` keeps Spotlight out of the worktrees: each one carries a CoW clone of
    // node_modules, which the indexer walks as fresh paths every time, so it never converges.
    // The suffix is the only mechanism that works: `.metadata_never_index` is ignored on a
    // subdirectory, and a symlinked node_modules gets replaced by `npm install`.
    worktreesDir: join(home, "worktrees.noindex"),
    themesDir: join(home, "themes"),
    agentsDir: process.env.TOYON_AGENTS_DIR ?? join(home, "agents"),
    agentsFile: join(home, "agents.json"),
    scratchDir: join(home, "scratch"),
    gitCredentialsFile: join(home, "git-credentials"),
  };
}

export function ensureDirs(p: Paths) {
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  mkdirSync(p.transcriptsDir, { recursive: true });
  mkdirSync(p.attachmentsDir, { recursive: true });
  mkdirSync(p.archiveDir, { recursive: true });
  mkdirSync(p.worktreesDir, { recursive: true });
  mkdirSync(p.themesDir, { recursive: true });
  mkdirSync(p.agentsDir, { recursive: true });
  mkdirSync(p.scratchDir, { recursive: true });
}
