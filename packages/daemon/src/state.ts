import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { RepoInfo, ThemePrefs, WorktreeInfo } from "@orchardist/shared";
import { ensureDirs, STATE_FILE, TOKEN_FILE } from "./paths.ts";

export interface PersistedState {
  repos: RepoInfo[];
  worktrees: WorktreeInfo[];
  /** worktreeId -> Claude session id, for resume */
  sessions: Record<string, string>;
  /** shell theme selection (shared by every browser that connects) */
  theme?: ThemePrefs;
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
  // cloud mode seeds the token from a secret so the provisioner can print the URL;
  // hex-only because the shell's fragment parser (shell/src/ws.ts) only accepts hex
  const seeded = process.env.ORCHARDIST_TOKEN;
  if (seeded) {
    if (!/^[a-f0-9]{16,}$/.test(seeded)) {
      throw new Error("ORCHARDIST_TOKEN must be lowercase hex, at least 16 chars");
    }
    writeFileSync(TOKEN_FILE, seeded, { mode: 0o600 });
    return seeded;
  }
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}
