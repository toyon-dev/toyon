import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { RepoInfo, WorktreeInfo } from "@orchardist/shared";
import { STATE_FILE, TOKEN_FILE, ensureDirs } from "./paths.ts";

export interface PersistedState {
  repos: RepoInfo[];
  worktrees: WorktreeInfo[];
  /** worktreeId -> Claude session id, for resume */
  sessions: Record<string, string>;
}

const empty: PersistedState = { repos: [], worktrees: [], sessions: {} };

export function loadState(): PersistedState {
  ensureDirs();
  if (!existsSync(STATE_FILE)) return structuredClone(empty);
  try {
    return { ...structuredClone(empty), ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return structuredClone(empty);
  }
}

export function saveState(state: PersistedState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function loadOrCreateToken(): string {
  ensureDirs();
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}
