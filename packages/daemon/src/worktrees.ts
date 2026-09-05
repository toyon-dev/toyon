import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  AgentEvent, AgentStatus, OrchardistConfig, ProcState, RepoInfo, ServerMsg, WorktreeInfo, WorktreeStatus,
} from "@orchardist/shared";
import { detectConfig } from "./config.ts";
import {
  aheadBehind, committedFiles, defaultBranch, git, gitOrThrow, isGitRepo, lockfileHash,
  repoRoot, statusFiles, withRepoLock,
} from "./git.ts";
import { watchDefaultBranch } from "./watcher.ts";
import { allocatePort } from "./ports.ts";
import { startProxy, type WorktreeProxy } from "./proxy.ts";
import { AgentSession, quickName } from "./agent.ts";
import { WorktreeProcs } from "./supervisor.ts";
import { loadState, saveState, type PersistedState } from "./state.ts";
import { WORKTREES_DIR } from "./paths.ts";

export interface HubEvents {
  proc(worktreeId: string, proc: ProcState): void;
  log(worktreeId: string, proc: string, line: string): void;
  agent(worktreeId: string, seq: number, event: AgentEvent): void;
  agentStatus(worktreeId: string, status: AgentStatus): void;
  worktreesChanged(): void;
  /** the repo's default branch moved: badges + git-status need refreshing */
  repoTick(repoId: string): void;
}

interface Runtime {
  info: WorktreeInfo;
  procs: WorktreeProcs;
  proxy: WorktreeProxy;
  agent: AgentSession;
}

export class Manager {
  state: PersistedState;
  runtimes = new Map<string, Runtime>();
  private bridgeCache: string | null = null;

  constructor(private hub: HubEvents, private bridgePath: string) {
    this.state = loadState();
  }

  // ---- boot ----

  async boot() {
    // restart runtimes for persisted worktrees whose paths still exist
    this.state.worktrees = this.state.worktrees.filter(
      (wt) => existsSync(wt.path) && this.state.repos.some((r) => r.id === wt.repoId),
    );
    for (const wt of this.state.worktrees) {
      const repo = this.repo(wt.repoId);
      await this.startRuntime(wt, repo);
    }
    saveState(this.state);
    for (const repo of this.state.repos) {
      this.startWatcher(repo);
      this.adoptOrCreateSpare(repo.id);
    }
  }

  // ---- ref watcher + spare pool ----

  private spares = new Map<string, {
    worktreeId: string;
    lockHash: string;
    refreshing: Promise<void> | null;
    ready: boolean;
  }>();
  private watchers = new Map<string, () => void>();

  private startWatcher(repo: RepoInfo) {
    if (this.watchers.has(repo.id)) return;
    this.watchers.set(
      repo.id,
      watchDefaultBranch(repo.path, repo.defaultBranch, () => {
        this.countsCache.clear();
        this.hub.repoTick(repo.id);
        void this.refreshSpare(repo.id);
      }),
    );
  }

  /** Reuse a persisted spare from a previous daemon run, else warm a fresh one. */
  private adoptOrCreateSpare(repoId: string) {
    const persisted = this.state.worktrees.filter((w) => w.repoId === repoId && w.kind === "spare");
    // keep at most one; stale extras are removed
    for (const extra of persisted.slice(1)) void this.removeWorktree(extra.id, true);
    const spare = persisted[0];
    if (spare) {
      this.spares.set(repoId, {
        worktreeId: spare.id,
        lockHash: lockfileHash(spare.path),
        refreshing: null,
        ready: true,
      });
      void this.refreshSpare(repoId); // main may have moved while the daemon was down
    } else {
      void this.ensureSpare(repoId);
    }
  }

  private async ensureSpare(repoId: string) {
    if (this.spares.has(repoId)) return;
    const repo = this.repo(repoId);
    const entry = { worktreeId: "", lockHash: "", refreshing: null as Promise<void> | null, ready: false };
    this.spares.set(repoId, entry);
    try {
      const slug = `spare-${shortId().slice(0, 4)}`;
      const wtPath = join(WORKTREES_DIR, repo.name, slug);
      await withRepoLock(repo.path, () => {
        gitOrThrow(repo.path, "worktree", "add", "--detach", wtPath, repo.defaultBranch);
      });
      const wt: WorktreeInfo = {
        id: shortId(),
        repoId,
        path: wtPath,
        branch: repo.defaultBranch,
        kind: "spare",
        proxyPort: await allocatePort(),
        title: slug,
        createdAt: Date.now(),
      };
      entry.worktreeId = wt.id;
      this.state.worktrees.push(wt);
      saveState(this.state);
      await this.setupAndStart(wt, repo); // CoW deps + setup + warm servers
      entry.lockHash = lockfileHash(wt.path);
      entry.ready = true;
    } catch {
      this.spares.delete(repoId);
    }
  }

  private async refreshSpare(repoId: string) {
    const entry = this.spares.get(repoId);
    if (!entry || !entry.ready || entry.refreshing) return;
    const repo = this.repo(repoId);
    const wt = this.worktree(entry.worktreeId);
    if (!wt || wt.kind !== "spare") return;
    entry.refreshing = (async () => {
      await withRepoLock(repo.path, () => {
        git(wt.path, "reset", "--hard", repo.defaultBranch);
      });
      const h = lockfileHash(wt.path);
      if (h !== entry.lockHash) {
        entry.lockHash = h;
        for (const cmd of repo.config.setup ?? []) {
          spawnSync("sh", ["-c", cmd], { cwd: wt.path, encoding: "utf8" });
        }
      }
    })().finally(() => {
      entry.refreshing = null;
    });
    await entry.refreshing;
  }

  /** Claim the warm spare for a new task: branch it, hand it to an agent, warm the next. */
  private async claimSpare(repoId: string, branch: string, slug: string): Promise<WorktreeInfo | null> {
    const entry = this.spares.get(repoId);
    if (!entry?.ready) return null;
    this.spares.delete(repoId);
    // a refresh in flight serializes in front of the agent's first action
    if (entry.refreshing) await entry.refreshing;
    const wt = this.worktree(entry.worktreeId);
    if (!wt || wt.kind !== "spare") return null;
    const repo = this.repo(repoId);
    await withRepoLock(repo.path, () => {
      gitOrThrow(wt.path, "switch", "-c", branch);
    });
    wt.kind = "worktree";
    wt.branch = branch;
    wt.title = slug;
    wt.createdAt = Date.now();
    saveState(this.state);
    void this.ensureSpare(repoId).then(() => this.hub.worktreesChanged());
    return wt;
  }

  // ---- repos ----

  repo(id: string): RepoInfo {
    const r = this.state.repos.find((x) => x.id === id);
    if (!r) throw new Error(`unknown repo ${id}`);
    return r;
  }

  async registerRepo(path: string): Promise<RepoInfo> {
    if (!isGitRepo(path)) throw new Error(`${path} is not a git repository`);
    const root = repoRoot(path);
    const existing = this.state.repos.find((r) => r.path === root);
    if (existing) return existing;

    const detected = detectConfig(root);
    const repo: RepoInfo = {
      id: shortId(),
      path: root,
      name: basename(root),
      defaultBranch: defaultBranch(root),
      config: detected.config,
      needsSetup: detected.needsSetup,
    };
    this.state.repos.push(repo);

    // the repo's own checkout is the "main" pseudo-worktree
    const main: WorktreeInfo = {
      id: shortId(),
      repoId: repo.id,
      path: root,
      branch: repo.defaultBranch,
      kind: "main",
      proxyPort: await allocatePort(),
      title: "main",
      createdAt: Date.now(),
    };
    this.state.worktrees.push(main);
    saveState(this.state);
    await this.startRuntime(main, repo);
    this.startWatcher(repo);
    void this.ensureSpare(repo.id);
    this.hub.worktreesChanged();
    return repo;
  }

  confirmConfig(repoId: string, config: OrchardistConfig) {
    const repo = this.repo(repoId);
    repo.config = config;
    repo.needsSetup = false;
    saveState(this.state);
    // restart procs for this repo's worktrees under the new config
    for (const wt of this.state.worktrees.filter((w) => w.repoId === repoId)) {
      const rt = this.runtimes.get(wt.id);
      if (rt) {
        rt.procs.stopAll();
        this.runtimes.delete(wt.id);
        void this.startRuntime(wt, repo);
      }
    }
    this.hub.worktreesChanged();
  }

  // ---- worktrees ----

  async createWorktree(repoId: string, prompt: string, baseWorktreeId?: string): Promise<WorktreeInfo> {
    const repo = this.repo(repoId);
    const slug = slugify(prompt);
    const branch = `orchard/${slug}`;

    // fork point: main's branch by default, or the base worktree's branch (stacking)
    const base = baseWorktreeId ? this.state.worktrees.find((w) => w.id === baseWorktreeId) : undefined;
    const fromMain = !base || base.kind === "main";

    // fast path: claim the pre-warmed spare (main-based tasks only)
    if (fromMain) {
      const claimed = await this.claimSpare(repoId, branch, slug);
      if (claimed) {
        this.hub.worktreesChanged();
        const agent = this.agentFor(claimed.id) ?? this.makeAgent(claimed);
        agent.send(prompt);
        void quickName(prompt, repo.path).then((name) => {
          if (name) this.renameWorktree(claimed.id, name).catch(() => {});
        });
        return claimed;
      }
    }

    const wtPath = join(WORKTREES_DIR, repo.name, slug);
    const baseBranch = fromMain ? repo.defaultBranch : base!.branch;
    await withRepoLock(repo.path, () => {
      gitOrThrow(repo.path, "worktree", "add", "-b", branch, wtPath, baseBranch);
    });

    const wt: WorktreeInfo = {
      id: shortId(),
      repoId,
      path: wtPath,
      branch,
      kind: "worktree",
      proxyPort: await allocatePort(),
      title: slug,
      createdAt: Date.now(),
    };
    this.state.worktrees.push(wt);
    saveState(this.state);
    this.hub.worktreesChanged();

    // setup + procs warm in the background; agent starts immediately
    void this.setupAndStart(wt, repo, base?.path ?? repo.path).then(() => this.hub.worktreesChanged());
    const rtAgent = this.makeAgent(wt);
    this.pendingAgents.set(wt.id, rtAgent);
    rtAgent.send(prompt);
    // a cheap async naming pass replaces the prompt-prefix slug when it lands
    void quickName(prompt, repo.path).then((name) => {
      if (name) this.renameWorktree(wt.id, name).catch(() => {});
    });
    return wt;
  }

  setLanded(worktreeId: string, landed: boolean) {
    const wt = this.state.worktrees.find((w) => w.id === worktreeId);
    if (!wt || wt.landed === landed || (landed && wt.kind === "main")) return;
    wt.landed = landed;
    saveState(this.state);
    this.hub.worktreesChanged();
  }

  async renameWorktree(worktreeId: string, title: string) {
    const wt = this.state.worktrees.find((w) => w.id === worktreeId);
    if (!wt || wt.kind === "main") return;
    const repo = this.repo(wt.repoId);
    const clean = title.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    if (!clean) return;
    await withRepoLock(repo.path, () => {
      let branch = `orchard/${clean}`;
      if (branch !== wt.branch) {
        // avoid collisions with an existing branch
        for (let n = 2; !git(wt.path, "branch", "-m", wt.branch, branch).ok; n++) {
          if (n > 5) return;
          branch = `orchard/${clean}-${n}`;
        }
        wt.branch = branch;
      }
      wt.title = clean;
    });
    saveState(this.state);
    this.hub.worktreesChanged();
  }

  private pendingAgents = new Map<string, AgentSession>();

  private async setupAndStart(wt: WorktreeInfo, repo: RepoInfo, depsSource = repo.path) {
    // CoW-clone node_modules from the base checkout (APFS); harmless no-op elsewhere
    const srcNm = join(depsSource, "node_modules");
    const dstNm = join(wt.path, "node_modules");
    if (existsSync(srcNm) && !existsSync(dstNm)) {
      const r = spawnSync("cp", ["-Rc", srcNm, dstNm]);
      if (r.status !== 0) spawnSync("cp", ["-R", srcNm, dstNm]);
    }
    for (const cmd of repo.config.setup ?? []) {
      const r = spawnSync("sh", ["-c", cmd], { cwd: wt.path, encoding: "utf8" });
      if (r.status !== 0) this.hub.log(wt.id, "setup", `setup failed: ${cmd}: ${r.stderr}`);
    }
    await this.startRuntime(wt, repo);
  }

  async removeWorktree(worktreeId: string, allowSpare = false) {
    const wt = this.state.worktrees.find((w) => w.id === worktreeId);
    if (!wt || wt.kind === "main" || (wt.kind === "spare" && !allowSpare)) return;
    const repo = this.repo(wt.repoId);
    const rt = this.runtimes.get(worktreeId);
    rt?.procs.stopAll();
    rt?.proxy.stop();
    this.runtimes.delete(worktreeId);
    await withRepoLock(repo.path, () => {
      gitOrThrow(repo.path, "worktree", "remove", "--force", wt.path);
    });
    this.state.worktrees = this.state.worktrees.filter((w) => w.id !== worktreeId);
    delete this.state.sessions[worktreeId];
    saveState(this.state);
    this.hub.worktreesChanged();
  }

  // ---- runtime assembly ----

  private makeAgent(wt: WorktreeInfo): AgentSession {
    const existing = this.runtimes.get(wt.id)?.agent ?? this.pendingAgents.get(wt.id);
    if (existing) return existing;
    return new AgentSession(
      wt.id,
      wt.path,
      () => this.state.sessions[wt.id],
      (id) => {
        this.state.sessions[wt.id] = id;
        saveState(this.state);
      },
      (event, seq) => this.hub.agent(wt.id, seq, event),
      (status) => this.hub.agentStatus(wt.id, status),
    );
  }

  private async startRuntime(wt: WorktreeInfo, repo: RepoInfo) {
    if (this.runtimes.has(wt.id)) return;
    const procs = new WorktreeProcs(
      wt.path,
      (p) => this.hub.proc(wt.id, p),
      (proc, line) => this.hub.log(wt.id, proc, line),
    );

    // start non-preview procs first so the preview proc can get their URLs
    const previewName = repo.config.preview ?? (repo.config.procs["web"] ? "web" : Object.keys(repo.config.procs)[0]);
    const extraEnv: Record<string, string> = {};
    for (const [name, cmd] of Object.entries(repo.config.procs)) {
      if (name === previewName) continue;
      const st = await procs.start(name, cmd);
      const urlVar = `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
      extraEnv[urlVar] = `http://127.0.0.1:${st.port}`;
      extraEnv[`VITE_${urlVar}`] = extraEnv[urlVar];
      if (name === "api") {
        extraEnv["API_URL"] = extraEnv[urlVar];
        extraEnv["VITE_API_URL"] = extraEnv[urlVar];
      }
    }
    if (previewName && repo.config.procs[previewName]) {
      await procs.start(previewName, repo.config.procs[previewName]!, extraEnv);
    }

    const proxy = startProxy({
      port: wt.proxyPort,
      bridgeScript: () => this.bridgeScript(),
      getTarget: () => {
        const st = procs.states().find((p) => p.name === previewName);
        if (!st) {
          // backend-only repo: point preview at the first proc
          const first = procs.states()[0];
          return first && first.status !== "crashed" ? first.port : null;
        }
        return st.status === "crashed" ? null : st.port;
      },
    });

    const agent = this.makeAgent(wt);
    this.pendingAgents.delete(wt.id);
    this.runtimes.set(wt.id, { info: wt, procs, proxy, agent });
    this.hub.worktreesChanged();
  }

  private bridgeScript(): string {
    if (this.bridgeCache) return this.bridgeCache;
    if (existsSync(this.bridgePath)) {
      this.bridgeCache = readFileSync(this.bridgePath, "utf8");
      return this.bridgeCache;
    }
    return "// orchardist bridge not built";
  }

  // ---- queries ----

  private countsCache = new Map<string, { ahead?: number; behind?: number; dirty: number; at: number }>();

  private counts(wt: WorktreeInfo): { ahead?: number; behind?: number; dirty?: number } {
    const cached = this.countsCache.get(wt.id);
    if (cached && Date.now() - cached.at < 10_000) return cached;
    try {
      const ab = wt.kind === "main" ? {} : aheadBehind(wt.path, this.repo(wt.repoId).defaultBranch);
      const fresh = { ...ab, dirty: statusFiles(wt.path).length, at: Date.now() };
      this.countsCache.set(wt.id, fresh);
      return fresh;
    } catch {
      return cached ?? {};
    }
  }

  /** git-status payload for one worktree (used by subscribe, edits, and ref ticks) */
  gitStatusMsg(worktreeId: string): Extract<ServerMsg, { t: "git-status" }> | null {
    const wt = this.worktree(worktreeId);
    if (!wt || wt.kind === "spare") return null;
    try {
      const files = statusFiles(wt.path);
      const defaultBr = this.repo(wt.repoId).defaultBranch;
      const counts = wt.kind === "main" ? {} : aheadBehind(wt.path, defaultBr);
      const ahead = (counts as { ahead?: number }).ahead ?? 0;
      const committed = wt.kind !== "main" && ahead > 0 ? committedFiles(wt.path, defaultBr) : undefined;
      if (wt.landed && (files.length > 0 || ahead > 0)) this.setLanded(wt.id, false);
      return { t: "git-status", worktreeId, files, committed, ...counts };
    } catch {
      return null;
    }
  }

  statuses(): WorktreeStatus[] {
    return this.state.worktrees.filter((wt) => wt.kind !== "spare").map((wt) => {
      const rt = this.runtimes.get(wt.id);
      const pending = this.pendingAgents.get(wt.id);
      const { ahead, behind, dirty } = this.counts(wt);
      return {
        worktree: wt,
        procs: rt?.procs.states() ?? [],
        agent: rt?.agent.status ?? pending?.status ?? "idle",
        ahead,
        behind,
        dirty,
      };
    });
  }

  /** Ephemeral local octopus merge of several worktree branches, as its own preview worktree. */
  async combineWorktrees(worktreeIds: string[]): Promise<WorktreeInfo> {
    const wts = worktreeIds
      .map((id) => this.state.worktrees.find((w) => w.id === id))
      .filter((w): w is WorktreeInfo => !!w && w.kind !== "main");
    if (wts.length < 2) throw new Error("select at least two worktrees to combine");
    const repoId = wts[0]!.repoId;
    if (!wts.every((w) => w.repoId === repoId)) throw new Error("worktrees must belong to one repo");
    const repo = this.repo(repoId);

    // graft names are the recipe: <a>+<b> (the ⧉ icon marks it as a graft); random suffix only on collision
    let slug = wts.map((w) => w.title.split("-")[0]).join("+").slice(0, 40);
    if (git(repo.path, "show-ref", "--verify", `refs/heads/orchard/${slug}`).ok) {
      slug = `${slug.slice(0, 34)}-${shortId().slice(0, 4)}`;
    }
    const branch = `orchard/${slug}`;
    const wtPath = join(WORKTREES_DIR, repo.name, slug);

    await withRepoLock(repo.path, () => {
      gitOrThrow(repo.path, "worktree", "add", "-b", branch, wtPath, repo.defaultBranch);
      const m = git(wtPath, "merge", "--no-edit", ...wts.map((w) => w.branch));
      if (!m.ok) {
        git(wtPath, "merge", "--abort");
        git(repo.path, "worktree", "remove", "--force", wtPath);
        git(repo.path, "branch", "-D", branch);
        throw new Error(`branches conflict — these worktrees can't be grafted cleanly (${m.err.slice(0, 200)})`);
      }
    });

    const wt: WorktreeInfo = {
      id: shortId(),
      repoId,
      path: wtPath,
      branch,
      kind: "combined",
      proxyPort: await allocatePort(),
      title: slug,
      createdAt: Date.now(),
      sources: wts.map((w) => w.id),
    };
    this.state.worktrees.push(wt);
    saveState(this.state);
    this.hub.worktreesChanged();
    void this.setupAndStart(wt, repo, wts[0]!.path).then(() => this.hub.worktreesChanged());
    return wt;
  }

  runtime(worktreeId: string): Runtime | undefined {
    return this.runtimes.get(worktreeId);
  }

  agentFor(worktreeId: string): AgentSession | undefined {
    return this.runtimes.get(worktreeId)?.agent ?? this.pendingAgents.get(worktreeId);
  }

  worktree(worktreeId: string): WorktreeInfo | undefined {
    return this.state.worktrees.find((w) => w.id === worktreeId);
  }

  shutdown() {
    for (const stop of this.watchers.values()) stop();
    for (const rt of this.runtimes.values()) {
      rt.procs.stopAll();
      rt.proxy.stop();
    }
  }
}

function shortId(): string {
  return randomBytes(5).toString("hex");
}

function slugify(prompt: string): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter(Boolean).slice(0, 4);
  const base = words.join("-").slice(0, 40) || "task";
  return `${base}-${randomBytes(2).toString("hex")}`;
}
