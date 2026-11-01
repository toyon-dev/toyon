import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  AgentCommand,
  AgentPicks,
  KeepAwakeMode,
  ModelChoice,
  PairedMachine,
  PermissionMode,
  PrComment,
  RepoInfo,
  RepoPicks,
  ThemePrefs,
  WorktreeInfo,
} from "@toyon/shared";
import { isShellOrigin, PERMISSION_MODES, relistChoice, sentAt } from "@toyon/shared";
import { UserError } from "./errors.ts";
import { log } from "./log.ts";
import { ensureDirs, type Paths } from "./paths.ts";

/** how many let-in shell origins are kept; the oldest goes when a seventeenth is let in */
const TRUSTED_MAX = 16;

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
  /** the value each agent ran per category the last time a session opened with nothing asked
   * for, keyed like optionCache: what its default row stands for, which the row's words need not
   * say (an agent's own settings pick its default) */
  optionDefaults?: Record<string, Record<string, string>>;
  /** the shape before optionCache; read once at load and folded in */
  modelCache?: Record<string, ModelChoice[]>;
  /** shell theme selection (shared by every browser that connects) */
  theme?: ThemePrefs;
  /** registry id new worktrees get when the prompt does not pick one */
  defaultAgent?: string;
  /** what a new worktree of each agent is asked to run, as picked in the composer: the model and
   * effort stamped on the record at birth where the create names none. The agent's own default
   * where absent. Keyed by registry id. */
  picks?: Record<string, AgentPicks>;
  /** the keep-awake line in settings, kept only once it is moved off "use" */
  keepAwake?: Exclude<KeepAwakeMode, "use">;
  /** each repo's preview pages and how much they are used (routes/frecency.ts), by repo id then
   * page. Beside the repo rather than on RepoInfo, which is broadcast whole on every config change
   * and would carry this to every tab each time. */
  visits?: Record<string, Record<string, PageVisit>>;
  /** per worktree, found ones included: the page files last opened there and what they held
   * (routes/seen.ts), so a page the agent changed afterwards can say so */
  seen?: Record<string, SeenRecord>;
  /** per worktree, the remarks on its open PR as last read (prs.ts): what its page shows, and what a
   * later read is measured against, so nothing rings twice across a restart. The size of the PR. */
  prComments?: Record<string, PrCommentsRecord>;
  /** when this daemon first read PR comments: a remark older than that was written before Toyon
   * read any, and a PR that already had a long thread does not ring for all of it */
  prCommentsFrom?: number;
  /** the last update whose install failed, so the automatic path does not retry it every minute */
  updateFailed?: { version: string; at: number };
  /** when an npx start's offer of a global install was answered, by installing or turning it down */
  globalInstallAt?: number;
  /** when a device opening this machine's own address was first let in; the desk's bar stops
   * offering the address in words after that */
  letInAt?: number;
  /** The shell origins that have been let in to this machine from another one (a Toyon served
   * elsewhere knocked here and was let in), newest last. Those pages talk to this daemon across origins,
   * so its answers carry CORS headers for them. Trust is not authentication: every such request
   * still needs the bearer token, which is why nothing here is ever revoked. */
  trustedOrigins?: { origin: string; at: number }[];
  /** Other machines this daemon was handed, with their tokens: a deploy run from this box, or a
   * shell it serves that another machine let in. Every shell that connects here lists them, so a
   * pairing is done once per machine and not once per browser. The tokens sit on disk beside the
   * git credentials, which grant as much. */
  machines?: PairedMachine[];
  /** The process groups the daemon owns, per worktree (found ones included, under their disc- id):
   * every dev server, agent adapter, shell and login it spawned. The next daemon reads this to
   * reclaim what a crash or a kill left running, since a pgid otherwise lives only in the runtime. */
  groups?: Record<string, GroupEntry[]>;
  /** the machine's boot id when the ledger was last written; a different one at load means every
   * pid in it belongs to another life of the machine */
  bootAt?: string;
}

/** the ledger's key for what a removed worktree left running: nobody's but the daemon's to
 * reclaim, and kept where the prune of unknown worktree ids cannot reach it */
export const DAEMON_GROUPS = "daemon";

/** one process group the daemon owns */
export interface GroupEntry {
  pgid: number;
  /** what it is, for the log line: the proc's key, `agent:<id>`, `shell` or `login` */
  name: string;
  /** when it was first recorded, ms; a leader found later with another start time is a reused pid */
  startedAt: number;
}

/** proc events come in bursts (a wake spawns every proc of a worktree), and each save rewrites
 * the file; one write a beat later covers the burst */
const GROUPS_SAVE_MS = 250;

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

/** the remarks on one worktree's PR, for the PR it has now */
export interface PrCommentsRecord {
  pr: number;
  comments: PrComment[];
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
  // a queued piece's text was its `brief` until 0.17: the field is `plan` now, moved once here
  for (const w of state.worktrees) {
    for (const q of w.queued ?? []) {
      const old = q as unknown as { brief?: string; plan?: string };
      if (old.brief !== undefined && old.plan === undefined) {
        old.plan = old.brief;
        delete old.brief;
      }
    }
    // an `awaits` entry, a queued piece's `after` and a sibling's `from.after` copied the worktree's
    // branch and title until 0.20, and the copies went stale when the branch moved to its title:
    // each names the worktree by id alone now, the rest dropped once here
    const idOnly = (named: { id: string }) => {
      const old = named as { branch?: string; title?: string };
      delete old.branch;
      delete old.title;
    };
    for (const a of w.awaits ?? []) idOnly(a);
    for (const q of w.queued ?? []) if (!("piece" in q.after)) idOnly(q.after);
    if (w.from?.kind === "worktree" && w.from.after) idOnly(w.from.after);
  }
  // sessions belong to worktrees; a removed worktree's entry is an orphan
  const ids = new Set(state.worktrees.map((w) => w.id));
  for (const id of Object.keys(state.sessions)) if (!ids.has(id)) delete state.sessions[id];
  for (const id of Object.keys(state.prComments ?? {})) if (!ids.has(id)) delete state.prComments?.[id];
  // page records too, except a found worktree's: it has no record here to be checked against, and
  // its ids start disc- (worktrees/discover.ts)
  for (const id of Object.keys(state.seen ?? {})) {
    if (!ids.has(id) && !id.startsWith("disc-")) delete state.seen?.[id];
  }
  // the ledger too, with the same exception: a found worktree's shell has no record here either,
  // and what removed worktrees left is kept on purpose
  for (const id of Object.keys(state.groups ?? {})) {
    if (!ids.has(id) && !id.startsWith("disc-") && id !== DAEMON_GROUPS) delete state.groups?.[id];
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
  // The file is the only source, never the environment: every proc, setup step, terminal and agent
  // inherits this process's environment, and Bun.spawn without an `env` hands children the one the
  // process started with, whatever was deleted from process.env since. A machine whose token comes
  // from a platform secret writes it here before the daemon starts (the cloud entrypoint).
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
  /** the coalesced ledger write, while one is pending */
  private groupsTimer: ReturnType<typeof setTimeout> | null = null;

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

  /** the remarks on a worktree's PR as last read, live; undefined until the first read */
  prCommentsOf(worktreeId: string): PrCommentsRecord | undefined {
    return this.state.prComments?.[worktreeId];
  }
  /** No save: the PR service saves with the summary on the worktree that goes with it */
  setPrComments(worktreeId: string, rec: PrCommentsRecord) {
    this.state.prComments ??= {};
    this.state.prComments[worktreeId] = rec;
  }
  /** when PR remarks were first read here, stamped on the first ask */
  prCommentsFrom(now: number): number {
    if (this.state.prCommentsFrom === undefined) {
      this.state.prCommentsFrom = now;
      this.save();
    }
    return this.state.prCommentsFrom;
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
  /** drops the record and its session id; the caller has already stopped the runtime. A group
   * still on its books is one that outlived the stop: it moves to the daemon's own bucket, so the
   * next boot still finds it with the worktree gone. The row's send stays on its project: the
   * switcher sorts projects by their newest send and reads it off the rows, so a project whose
   * rows were all tidied away would otherwise forget it was worked in. The spare carries no send,
   * and nor does a row `refused`: one listed ahead of git and taken back when git said no. */
  removeWorktree(id: string, opts: { refused?: boolean } = {}) {
    const wt = this.state.worktrees.find((w) => w.id === id);
    const repo = wt && wt.kind !== "spare" && !opts.refused ? this.repo(wt.repoId) : undefined;
    if (wt && repo) repo.promptedAt = Math.max(repo.promptedAt ?? 0, sentAt(wt));
    this.state.worktrees = this.state.worktrees.filter((w) => w.id !== id);
    delete this.state.sessions[id];
    if (this.state.seen) delete this.state.seen[id];
    if (this.state.prComments) delete this.state.prComments[id];
    if (this.state.groups) {
      const left = this.state.groups[id] ?? [];
      delete this.state.groups[id];
      if (left.length > 0) this.state.groups[DAEMON_GROUPS] = [...(this.state.groups[DAEMON_GROUPS] ?? []), ...left];
    }
    this.save();
  }

  /** the process groups recorded for a worktree; empty when none */
  groups(worktreeId: string): GroupEntry[] {
    return this.state.groups?.[worktreeId] ?? [];
  }
  /** replace a worktree's list; written a beat later, so a burst of proc events is one save */
  setGroups(worktreeId: string, list: GroupEntry[]) {
    this.state.groups ??= {};
    if (list.length === 0) delete this.state.groups[worktreeId];
    else this.state.groups[worktreeId] = list;
    if (this.groupsTimer) return;
    const t = setTimeout(() => {
      try {
        this.save();
      } catch (e) {
        log.warn("state", "could not write the process group ledger", e);
      }
    }, GROUPS_SAVE_MS);
    // a write pending must not keep a test, or a shutdown, waiting
    t.unref?.();
    this.groupsTimer = t;
  }
  /** the write that is pending, now: a shutdown is about to remove the pid file and exit */
  flushGroups() {
    if (this.groupsTimer) this.save();
  }
  /** every entry with its worktree, for the boot that reads the ledger */
  allGroups(): Array<GroupEntry & { worktreeId: string }> {
    const out: Array<GroupEntry & { worktreeId: string }> = [];
    for (const [worktreeId, list] of Object.entries(this.state.groups ?? {})) {
      for (const g of list) out.push({ ...g, worktreeId });
    }
    return out;
  }
  /** the whole ledger goes: what it listed has been reclaimed, or belongs to another boot */
  clearGroups() {
    delete this.state.groups;
    this.save();
  }
  get bootAt(): string | undefined {
    return this.state.bootAt;
  }
  setBootAt(id: string | null) {
    if (id === null) delete this.state.bootAt;
    else this.state.bootAt = id;
    this.save();
  }
  /** the worktree's permission mode. Returns whether it changed, so the caller can skip a
   * broadcast that says nothing new. Set by a person (the chip, through the worktree service, which
   * also tells a running agent) and by a plan approval (the session's dep, where the agent has
   * already switched itself). A spare has no mode to set. */
  setMode(worktreeId: string, mode: PermissionMode): boolean {
    const wt = this.requireWorktree(worktreeId);
    if (wt.kind === "spare") throw new UserError("no mode for a spare worktree");
    if (wt.mode === mode) return false;
    wt.mode = mode;
    this.save();
    return true;
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
  /** what the agent ran in the category when nothing was asked for, if a fresh session has said */
  cachedDefault(agentId: string, category: string): string | undefined {
    return this.state.optionDefaults?.[agentId]?.[category];
  }
  /** `runs` is the category's current value on a session that opened fresh with nothing asked
   * for: the agent's own default. Absent on a resumed session or a list re-read after a switch,
   * which keeps the default last seen. Returns whether anything changed, so the caller can skip a
   * broadcast that says nothing new. */
  setCachedOptions(agentId: string, category: string, choices: ModelChoice[], runs?: string): boolean {
    const sameList = JSON.stringify(this.cachedOptions(agentId, category)) === JSON.stringify(choices);
    const sameDefault = runs === undefined || runs === this.cachedDefault(agentId, category);
    if (sameList && sameDefault) return false;
    this.state.optionCache ??= {};
    this.state.optionCache[agentId] ??= {};
    this.state.optionCache[agentId][category] = choices;
    if (runs !== undefined) {
      this.state.optionDefaults ??= {};
      this.state.optionDefaults[agentId] ??= {};
      this.state.optionDefaults[agentId][category] = runs;
    }
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
  /** the chosen default is no longer an agent this daemon has: back to nobody having chosen */
  clearDefaultAgent() {
    if (this.state.defaultAgent === undefined) return;
    delete this.state.defaultAgent;
    this.save();
  }

  /** what a new worktree of the agent is asked to run; empty where nothing was picked */
  picks(agentId: string): AgentPicks {
    return this.state.picks?.[agentId] ?? {};
  }
  /** The picks for a record being made, behind what its maker named, relisted against the agent's
   * list as last learned: a picked id the agent has since dropped is left out rather than stamped
   * on every new worktree (the session would switch off it and say so each time), and a model id
   * it renamed is followed. Taken as picked while the agent has listed nothing yet. */
  fillPicks(agentId: string, given: AgentPicks): AgentPicks {
    const picks = this.picks(agentId);
    const model = given.model ?? this.relisted(picks.model, this.cachedOptions(agentId, "model"), relistChoice);
    const effort =
      given.effort ??
      this.relisted(picks.effort, this.cachedOptions(agentId, "thought_level"), (id, choices) =>
        choices.some((c) => c.id === id) ? id : undefined,
      );
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  private relisted(
    id: string | undefined,
    choices: ModelChoice[],
    relist: (id: string, choices: ModelChoice[]) => string | undefined,
  ): string | undefined {
    if (!id || choices.length === 0) return id;
    return relist(id, choices);
  }
  /** What a new worktree of the repo starts with, as picked in the composer: its mode, and its
   * profile. The empty value is the default again. A mode is one of the three; a profile is one
   * the settings file has now, and one the file later loses is left out at the create. */
  setRepoPick(repoId: string, field: keyof RepoPicks, value: string) {
    const repo = this.requireRepo(repoId);
    const picks = repo.picks ?? {};
    if (!value) delete picks[field];
    else if (field === "mode") {
      if (!PERMISSION_MODES.some((m) => m.id === value)) throw new UserError(`"${value}" is not a mode`);
      picks.mode = value as PermissionMode;
    } else {
      if (!repo.config.profiles?.[value]) throw new UserError(`no profile "${value}" in ${repo.configFile}`);
      picks.profile = value;
    }
    if (Object.keys(picks).length > 0) repo.picks = picks;
    else delete repo.picks;
    this.save();
  }
  /** the empty value is the agent's own default: the field goes, and the entry with its last field */
  setPick(agentId: string, field: keyof AgentPicks, value: string) {
    const all = this.state.picks ?? {};
    const picks = all[agentId] ?? {};
    if (value) picks[field] = value;
    else delete picks[field];
    if (Object.keys(picks).length > 0) all[agentId] = picks;
    else delete all[agentId];
    if (Object.keys(all).length > 0) this.state.picks = all;
    else delete this.state.picks;
    this.save();
  }

  get keepAwake(): KeepAwakeMode {
    return this.state.keepAwake ?? "use";
  }
  setKeepAwake(mode: KeepAwakeMode) {
    if (mode === "use") delete this.state.keepAwake;
    else this.state.keepAwake = mode;
    this.save();
  }

  get theme(): ThemePrefs | undefined {
    return this.state.theme;
  }
  setTheme(prefs: ThemePrefs) {
    this.state.theme = prefs;
    this.save();
  }

  get updateFailed(): { version: string; at: number } | undefined {
    return this.state.updateFailed;
  }
  setUpdateFailed(failed: { version: string; at: number } | undefined) {
    this.state.updateFailed = failed;
    this.save();
  }

  get globalInstallAnswered(): boolean {
    return this.state.globalInstallAt !== undefined;
  }
  answerGlobalInstall() {
    this.state.globalInstallAt = Date.now();
    this.save();
  }

  get letIn(): boolean {
    return this.state.letInAt !== undefined;
  }
  /** the first let-in is the one worth keeping; later ones change nothing anyone reads */
  noteLetIn() {
    if (this.state.letInAt !== undefined) return;
    this.state.letInAt = Date.now();
    this.save();
  }

  /** the machines this daemon was handed, oldest first */
  get machines(): PairedMachine[] {
    return this.state.machines ?? [];
  }
  /** List a machine, replacing one already listed at that origin. Https only: its token would
   * cross a network in the clear to any other, and a loopback daemon's shell is reached by its
   * own link, not through a list. */
  addMachine(origin: string, token: string) {
    if (!isShellOrigin(origin) || !origin.startsWith("https://"))
      throw new UserError(`${origin} is not an https origin`);
    if (!token) throw new UserError("a machine is listed with its token");
    const list = this.machines.filter((m) => m.origin !== origin);
    list.push({ origin, token });
    this.state.machines = list;
    this.save();
  }
  forgetMachine(origin: string) {
    const list = (this.state.machines ?? []).filter((m) => m.origin !== origin);
    if (list.length === (this.state.machines ?? []).length) return;
    this.state.machines = list;
    this.save();
  }

  /** the origins another machine's shell reaches this daemon from, oldest first */
  get trustedOrigins(): string[] {
    return (this.state.trustedOrigins ?? []).map((t) => t.origin);
  }
  /** Remember a shell origin let in from another machine. Https, or plain http on a loopback
   * name (a desk's own daemon serving its page at 127.0.0.1): the page there holds this machine's
   * token, and any other plain-http page would have carried it across a network in the clear. The
   * newest sixteen, since a person has that many machines in a lifetime, not a session. */
  trustOrigin(origin: string) {
    if (!isShellOrigin(origin)) return;
    const list = (this.state.trustedOrigins ?? []).filter((t) => t.origin !== origin);
    list.push({ origin, at: Date.now() });
    this.state.trustedOrigins = list.slice(-TRUSTED_MAX);
    this.save();
  }

  save() {
    // the ledger is part of the file, so any save covers a write it had pending
    if (this.groupsTimer) clearTimeout(this.groupsTimer);
    this.groupsTimer = null;
    saveState(this.paths, this.state);
  }
}
