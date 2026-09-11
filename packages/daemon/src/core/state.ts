import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AgentCommand, ModelChoice, Prefs, RepoInfo, ThemePrefs, WorktreeInfo } from "@toyon/shared";
import { DEFAULT_PREFS } from "@toyon/shared";
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
  /** the select choices each agent last advertised per ACP option category (`model`,
   * `thought_level`), keyed by agent id, so a picker has a list before a worktree's own session
   * exists */
  optionCache?: Record<string, Record<string, ModelChoice[]>>;
  /** the shape before optionCache; read once at load and folded in */
  modelCache?: Record<string, ModelChoice[]>;
  /** shell theme selection (shared by every browser that connects) */
  theme?: ThemePrefs;
  /** registry id new worktrees get when the prompt does not pick one */
  defaultAgent?: string;
  /** only what someone changed: a preference added later reads its default */
  prefs?: Partial<Prefs>;
  /** each repo's preview pages and how much they are used (routes/frecency.ts), by repo id then
   * page. Beside the repo rather than on RepoInfo, which is broadcast whole on every config change
   * and would carry this to every tab each time. */
  visits?: Record<string, Record<string, PageVisit>>;
  /** per worktree, found ones included: the page files last opened there and what they held
   * (routes/seen.ts), so a page the agent changed afterwards can say so */
  seen?: Record<string, SeenRecord>;
}

/** one page's standing in a repo's list: a count that decays, as of `last`, and the title the page
 * had when it was last there */
export interface PageVisit {
  score: number;
  last: number;
  title?: string;
}

/** what one worktree remembers of the pages opened in it */
export interface SeenRecord {
  repoId: string;
  /** when a page was last opened here; past the cap the record opened longest ago goes */
  at: number;
  /** the file on screen, stamped again when it is left */
  here?: string;
  /** file to the hash of what it held when its page was last open */
  files: Record<string, string>;
}

/** worktrees whose page records are kept: a found worktree removed outside toyon never says so */
const SEEN_WORKTREES = 50;

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
  // page records too, except a found worktree's: it has no record here to be checked against, and
  // its ids start disc- (worktrees/discover.ts)
  for (const id of Object.keys(state.seen ?? {})) {
    if (!ids.has(id) && !id.startsWith("disc-")) delete state.seen?.[id];
  }
  if (state.modelCache) {
    state.optionCache ??= {};
    for (const [agentId, models] of Object.entries(state.modelCache)) {
      state.optionCache[agentId] ??= {};
      state.optionCache[agentId].model ??= models;
    }
    delete state.modelCache;
  }
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
  /** drops the repo record, its page list and its worktrees' page records; the caller has removed its
   * worktrees and stopped its runtimes */
  removeRepo(id: string) {
    this.state.repos = this.state.repos.filter((r) => r.id !== id);
    if (this.state.visits) delete this.state.visits[id];
    for (const [worktreeId, rec] of Object.entries(this.state.seen ?? {})) {
      if (rec.repoId === id) delete this.state.seen?.[worktreeId];
    }
    this.save();
  }

  /** a worktree's page record, live like every record here; undefined until a page is opened there */
  seenOf(worktreeId: string): SeenRecord | undefined {
    return this.state.seen?.[worktreeId];
  }
  /** the same record, made on first use and marked as used now. Past the cap the record used longest
   * ago goes. No save: the route service decides when a visit is written. */
  seenFor(worktreeId: string, repoId: string, now: number): SeenRecord {
    this.state.seen ??= {};
    const seen = this.state.seen;
    let rec = seen[worktreeId];
    if (!rec) {
      rec = { repoId, at: now, files: {} };
      seen[worktreeId] = rec;
      const others = Object.entries(seen).filter(([id]) => id !== worktreeId);
      if (others.length >= SEEN_WORKTREES) {
        const oldest = others.reduce((a, b) => (b[1].at < a[1].at ? b : a));
        delete seen[oldest[0]];
      }
    }
    rec.at = now;
    return rec;
  }

  /** a repo's page list, live like every record here; undefined until its first visit */
  visitsOf(repoId: string): Record<string, PageVisit> | undefined {
    return this.state.visits?.[repoId];
  }
  /** the same list, made on first use. No save: the route service decides when a visit is written */
  visitsFor(repoId: string): Record<string, PageVisit> {
    this.state.visits ??= {};
    this.state.visits[repoId] ??= {};
    return this.state.visits[repoId];
  }
  addWorktree(wt: WorktreeInfo) {
    this.state.worktrees.push(wt);
    this.save();
  }
  /** drops the record and its session id; the caller has already stopped the runtime */
  removeWorktree(id: string) {
    this.state.worktrees = this.state.worktrees.filter((w) => w.id !== id);
    delete this.state.sessions[id];
    if (this.state.seen) delete this.state.seen[id];
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

  /** `category` is an ACP config option category; core sits below agent/, so it is a string here */
  cachedOptions(agentId: string, category: string): ModelChoice[] {
    return this.state.optionCache?.[agentId]?.[category] ?? [];
  }
  /** returns whether the list changed, so the caller can skip a broadcast that says nothing new */
  setCachedOptions(agentId: string, category: string, choices: ModelChoice[]): boolean {
    if (JSON.stringify(this.cachedOptions(agentId, category)) === JSON.stringify(choices)) return false;
    this.state.optionCache ??= {};
    this.state.optionCache[agentId] ??= {};
    this.state.optionCache[agentId][category] = choices;
    this.save();
    return true;
  }

  get defaultAgent(): string | undefined {
    return this.state.defaultAgent;
  }
  setDefaultAgent(id: string) {
    this.state.defaultAgent = id;
    this.save();
  }

  get prefs(): Prefs {
    return { ...DEFAULT_PREFS, ...this.state.prefs };
  }
  setPrefs(change: Partial<Prefs>) {
    const named = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
    this.state.prefs = { ...this.state.prefs, ...named };
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
