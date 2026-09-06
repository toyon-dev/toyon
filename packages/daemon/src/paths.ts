import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ORCHARDIST_HOME lets cloud mode keep state on a mounted volume (see cloud.ts)
export const ORCH_HOME = process.env.ORCHARDIST_HOME ?? join(homedir(), ".orchardist");
export const STATE_FILE = join(ORCH_HOME, "state.json");
export const TOKEN_FILE = join(ORCH_HOME, "token");
export const TRANSCRIPTS_DIR = join(ORCH_HOME, "transcripts");
export const WORKTREES_DIR = join(ORCH_HOME, "worktrees");
/** user-dropped theme files: Orchardist Theme JSON or raw VS Code theme JSON/JSONC */
export const THEMES_DIR = join(ORCH_HOME, "themes");

export function ensureDirs() {
  mkdirSync(ORCH_HOME, { recursive: true, mode: 0o700 });
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  mkdirSync(WORKTREES_DIR, { recursive: true });
  mkdirSync(THEMES_DIR, { recursive: true });
}
