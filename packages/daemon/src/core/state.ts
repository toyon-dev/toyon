import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { RepoInfo, ThemePrefs, WorktreeInfo } from "@orchardist/shared";
import { log } from "./log.ts";
import { ensureDirs, type Paths } from "./paths.ts";

export interface PersistedState {
  repos: RepoInfo[];
  worktrees: WorktreeInfo[];
  /** worktreeId -> Claude session id, for resume */
  sessions: Record<string, string>;
  /** shell theme selection (shared by every browser that connects) */
  theme?: ThemePrefs;
}

const empty: PersistedState = { repos: [], worktrees: [], sessions: {} };

export function loadState(paths: Paths): PersistedState {
  ensureDirs(paths);
  const STATE_FILE = paths.stateFile;
  if (!existsSync(STATE_FILE)) return structuredClone(empty);
  let raw: string;
  try {
    raw = readFileSync(STATE_FILE, "utf8");
  } catch (e) {
    log.error("state", `cannot read ${STATE_FILE}; starting empty`, e);
    return structuredClone(empty);
  }
  let state: PersistedState;
  try {
    state = { ...structuredClone(empty), ...JSON.parse(raw) };
  } catch (e) {
    // never silently forget every repo and worktree: keep the bad file for recovery
    const backup = `${STATE_FILE}.corrupt-${Date.now()}`;
    try {
      writeFileSync(backup, raw);
    } catch {}
    log.error("state", `${STATE_FILE} is not valid JSON; copied to ${backup} and starting empty`, e);
    return structuredClone(empty);
  }
  // sessions belong to worktrees; a removed worktree's entry is an orphan
  const ids = new Set(state.worktrees.map((w) => w.id));
  for (const id of Object.keys(state.sessions)) if (!ids.has(id)) delete state.sessions[id];
  return state;
}

/** Atomic: a crash mid-write must not leave a half-written state.json (which loadState would reject). */
export function saveState(paths: Paths, state: PersistedState) {
  const tmp = `${paths.stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, paths.stateFile);
}

export function loadOrCreateToken(paths: Paths): string {
  ensureDirs(paths);
  const TOKEN_FILE = paths.tokenFile;
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
