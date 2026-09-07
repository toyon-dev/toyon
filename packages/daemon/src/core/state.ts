import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AgentCommand, RepoInfo, ThemePrefs, WorktreeInfo } from "@toyon/shared";
import { UserError } from "./errors.ts";
import { log } from "./log.ts";
import { ensureDirs, type Paths } from "./paths.ts";

export interface PersistedState {
  repos: RepoInfo[];
  worktrees: WorktreeInfo[];
  /** worktreeId -> the agent's own session id, for resume (only meaningful for that worktree's agent) */
  sessions: Record<string, string>;
  /** the slash commands an agent last advertised, keyed `<agentId>:<repoId>`. Only a seed: a new
   * worktree shows these until its own agent starts and says otherwise. The list is really a
   * function of the repo's .claude/ plus the user's settings, so the last one is a good guess and
   * beats an empty menu on every worktree until the first prompt. */
  commandCache?: Record<string, AgentCommand[]>;
  /** shell theme selection (shared by every browser that connects) */
  theme?: ThemePrefs;
  /** registry id new worktrees get when the prompt does not pick one */
  defaultAgent?: string;
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
    } catch (be) {
      log.warn("state", "could not write the corrupt-state backup", be);
    }
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
  const seeded = process.env.TOYON_TOKEN;
  if (seeded) {
    if (!/^[a-f0-9]{16,}$/.test(seeded)) {
      throw new Error("TOYON_TOKEN must be lowercase hex, at least 16 chars");
    }
    writeFileSync(TOKEN_FILE, seeded, { mode: 0o600 });
    return seeded;
  }
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

/**
 * The daemon's persisted state with lookups and a single save(). Hands out LIVE references on
 * purpose: services mutate a worktree record in place (claim a spare, rename, set prUrl) and then
 * call save(); cloning here would silently stop those writes from persisting.
 */
export class StateStore {
  readonly state: PersistedState;

  constructor(
    private paths: Paths,
    state?: PersistedState,
  ) {
    this.state = state ?? loadState(paths);
  }

  get repos(): RepoInfo[] {
    return this.state.repos;
  }
  get worktrees(): WorktreeInfo[] {
    return this.state.worktrees;
  }

  repo(id: string): RepoInfo | undefined {
    return this.state.repos.find((r) => r.id === id);
  }
  requireRepo(id: string): RepoInfo {
    const r = this.repo(id);
    if (!r) throw new UserError(`unknown repo ${id}`);
    return r;
  }
  worktree(id: string): WorktreeInfo | undefined {
    return this.state.worktrees.find((w) => w.id === id);
  }
  requireWorktree(id: string): WorktreeInfo {
    const w = this.worktree(id);
    if (!w) throw new UserError("unknown worktree");
    return w;
  }
  /** the worktree and its repo, or a UserError — the pair most service methods start from */
  requireWorktreeWithRepo(id: string): { wt: WorktreeInfo; repo: RepoInfo } {
    const wt = this.requireWorktree(id);
    return { wt, repo: this.requireRepo(wt.repoId) };
  }

  addRepo(repo: RepoInfo) {
    this.state.repos.push(repo);
    this.save();
  }
  /** drops the repo record only; the caller has removed its worktrees and stopped its runtimes */
  removeRepo(id: string) {
    this.state.repos = this.state.repos.filter((r) => r.id !== id);
    this.save();
  }
  addWorktree(wt: WorktreeInfo) {
    this.state.worktrees.push(wt);
    this.save();
  }
  /** drops the record and its session id; the caller has already stopped the runtime */
  removeWorktree(id: string) {
    this.state.worktrees = this.state.worktrees.filter((w) => w.id !== id);
    delete this.state.sessions[id];
    this.save();
  }
  /** keep only the worktrees the predicate accepts (boot-time pruning) */
  pruneWorktrees(keep: (wt: WorktreeInfo) => boolean) {
    this.state.worktrees = this.state.worktrees.filter(keep);
    this.save();
  }

  session(worktreeId: string): string | undefined {
    return this.state.sessions[worktreeId];
  }
  setSession(worktreeId: string, sessionId: string) {
    this.state.sessions[worktreeId] = sessionId;
    this.save();
  }

  /** what a worktree's `/` menu shows before its own agent has said anything */
  cachedCommands(agentId: string, repoId: string): AgentCommand[] {
    return this.state.commandCache?.[`${agentId}:${repoId}`] ?? [];
  }
  setCachedCommands(agentId: string, repoId: string, commands: AgentCommand[]) {
    this.state.commandCache ??= {};
    this.state.commandCache[`${agentId}:${repoId}`] = commands;
    this.save();
  }

  get defaultAgent(): string | undefined {
    return this.state.defaultAgent;
  }
  setDefaultAgent(id: string) {
    this.state.defaultAgent = id;
    this.save();
  }

  get theme(): ThemePrefs | undefined {
    return this.state.theme;
  }
  setTheme(prefs: ThemePrefs) {
    this.state.theme = prefs;
    this.save();
  }

  save() {
    saveState(this.paths, this.state);
  }
}
