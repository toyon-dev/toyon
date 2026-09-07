// Where the daemon keeps its state. Built once in index.ts and passed to everything that touches
// disk, so tests can each use a throwaway home (and nothing reads the env at import time).

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string;
  stateFile: string;
  tokenFile: string;
  transcriptsDir: string;
  /** images attached to chat messages, by worktree id (agent/attachments.ts) */
  attachmentsDir: string;
  worktreesDir: string;
  /** user-dropped theme files: Toyon Theme JSON or raw VS Code theme JSON/JSONC */
  themesDir: string;
}

/** TOYON_HOME lets cloud mode keep state on a mounted volume (see core/cloud.ts) */
export function makePaths(home = process.env.TOYON_HOME ?? join(homedir(), ".toyon")): Paths {
  return {
    home,
    stateFile: join(home, "state.json"),
    tokenFile: join(home, "token"),
    transcriptsDir: join(home, "transcripts"),
    attachmentsDir: join(home, "attachments"),
    worktreesDir: join(home, "worktrees"),
    themesDir: join(home, "themes"),
  };
}

export function ensureDirs(p: Paths) {
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  mkdirSync(p.transcriptsDir, { recursive: true });
  mkdirSync(p.attachmentsDir, { recursive: true });
  mkdirSync(p.worktreesDir, { recursive: true });
  mkdirSync(p.themesDir, { recursive: true });
}
