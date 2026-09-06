// One Runtime per worktree: its agent session (from the moment the worktree exists) plus, once
// setup has run, its process group and preview proxy. Replaces the old runtimes + pendingAgents
// pair, which four call sites each had to consult.

import type { ProcState, RepoInfo, WorktreeInfo } from "@orchardist/shared";
import type { AgentAdapter } from "../agent/adapter.ts";
import { AgentSession } from "../agent/session.ts";
import type { Hub } from "../core/hub.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import { type ProxyTarget, startProxy, type WorktreeProxy } from "./proxy.ts";
import { WorktreeProcs } from "./supervisor.ts";

export interface Runtime {
  info: WorktreeInfo;
  agent: AgentAdapter;
  /** null until start() has run (setup still in progress, or config unconfirmed) */
  procs: WorktreeProcs | null;
  proxy: WorktreeProxy | null;
  previewName: string | undefined;
}

export interface RuntimeDeps {
  hub: Hub;
  state: StateStore;
  paths: Paths;
  bridgeScript: () => string;
  /** factories, overridable so tests run without spawning anything */
  makeAgent?: (wt: WorktreeInfo, deps: RuntimeDeps) => AgentAdapter;
  makeProcs?: (wt: WorktreeInfo, deps: RuntimeDeps) => WorktreeProcs;
  makeProxy?: (
    wt: WorktreeInfo,
    previewName: string | undefined,
    procs: WorktreeProcs,
    deps: RuntimeDeps,
  ) => WorktreeProxy;
}

function defaultAgent(wt: WorktreeInfo, d: RuntimeDeps): AgentAdapter {
  const agent = new AgentSession(
    wt.id,
    wt.path,
    d.paths.transcriptsDir,
    () => d.state.session(wt.id),
    (id) => d.state.setSession(wt.id, id),
    (event, seq) => d.hub.emit("agent", wt.id, seq, event),
    (status) => d.hub.emit("agentStatus", wt.id, status),
  );
  agent.onQueueChange = () => d.hub.emit("queue", wt.id, agent.queueItems);
  return agent;
}

function defaultProcs(wt: WorktreeInfo, d: RuntimeDeps): WorktreeProcs {
  return new WorktreeProcs(
    wt.path,
    (p) => d.hub.emit("proc", wt.id, p),
    (proc, line) => d.hub.emit("log", wt.id, proc, line),
  );
}

function defaultProxy(wt: WorktreeInfo, previewName: string | undefined, procs: WorktreeProcs, d: RuntimeDeps) {
  return startProxy({
    port: wt.proxyPort,
    bridgeScript: d.bridgeScript,
    getTarget: () => previewTargetOf(procs, previewName),
  });
}

function previewTargetOf(procs: WorktreeProcs, previewName: string | undefined): ProxyTarget | null {
  const st =
    procs.states().find((p) => p.name === previewName) ??
    // backend-only repo: point preview at the first proc
    procs.states()[0];
  if (!st || st.status === "crashed") return null;
  return { port: st.port, host: st.host ?? "127.0.0.1" };
}

/** which proc the preview iframe shows: config.preview, else "web", else the first */
export function previewProcName(repo: RepoInfo, procs: Record<string, string>): string | undefined {
  return repo.config.preview ?? (procs.web ? "web" : Object.keys(procs)[0]);
}

export class RuntimeRegistry {
  private runtimes = new Map<string, Runtime>();

  constructor(private deps: RuntimeDeps) {}

  get(id: string): Runtime | undefined {
    return this.runtimes.get(id);
  }

  agentFor(id: string): AgentAdapter | undefined {
    return this.runtimes.get(id)?.agent;
  }

  /** the agent exists from the moment the worktree does; procs come later */
  ensureAgent(wt: WorktreeInfo): Runtime {
    const existing = this.runtimes.get(wt.id);
    if (existing) return existing;
    const rt: Runtime = {
      info: wt,
      agent: (this.deps.makeAgent ?? defaultAgent)(wt, this.deps),
      procs: null,
      proxy: null,
      previewName: undefined,
    };
    this.runtimes.set(wt.id, rt);
    return rt;
  }

  /** start the worktree's procs and proxy under the repo's config; no-op if already running */
  async start(wt: WorktreeInfo, repo: RepoInfo): Promise<void> {
    if (!this.deps.state.worktree(wt.id)) return; // removed while setup was running
    const rt = this.ensureAgent(wt);
    if (rt.procs) return;

    const procs = (this.deps.makeProcs ?? defaultProcs)(wt, this.deps);
    rt.procs = procs;
    // unconfirmed detection: no procs until the user confirms the config card
    const procEntries = repo.needsSetup ? {} : repo.config.procs;
    const previewName = previewProcName(repo, procEntries);
    rt.previewName = previewName;

    // start non-preview procs first so the preview proc can get their URLs
    const extraEnv: Record<string, string> = {};
    for (const [name, cmd] of Object.entries(procEntries)) {
      if (name === previewName) continue;
      const st = await procs.start(name, cmd);
      const urlVar = `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
      extraEnv[urlVar] = `http://127.0.0.1:${st.port}`;
      extraEnv[`VITE_${urlVar}`] = extraEnv[urlVar];
      if (name === "api") {
        extraEnv.API_URL = extraEnv[urlVar];
        extraEnv.VITE_API_URL = extraEnv[urlVar];
      }
    }
    if (previewName && procEntries[previewName]) {
      await procs.start(previewName, procEntries[previewName]!, extraEnv);
    }

    if (!this.deps.state.worktree(wt.id) || this.runtimes.get(wt.id) !== rt) {
      // removed while the procs were starting: don't leave them running
      await procs.stopAll();
      return;
    }
    rt.proxy = (this.deps.makeProxy ?? defaultProxy)(wt, previewName, procs, this.deps);
    this.deps.hub.emit("worktreesChanged");
  }

  /** stop procs and proxy but keep the agent (config confirmed → restart under the new config) */
  async stopProcs(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const { procs, proxy } = rt;
    rt.procs = null;
    rt.proxy = null;
    proxy?.stop();
    await procs?.stopAll();
  }

  /** stop everything for a worktree and forget it */
  async stop(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.runtimes.delete(id);
    rt.agent.stop();
    rt.proxy?.stop();
    await rt.procs?.stopAll();
  }

  restartProc(id: string, name: string) {
    this.runtimes.get(id)?.procs?.restart(name);
  }

  recentLogs(id: string): string[] {
    return this.runtimes.get(id)?.procs?.recentLogs() ?? [];
  }

  procStates(id: string): ProcState[] {
    return this.runtimes.get(id)?.procs?.states() ?? [];
  }

  previewTarget(id: string): ProxyTarget | null {
    const rt = this.runtimes.get(id);
    if (!rt?.procs) return null;
    const t = previewTargetOf(rt.procs, rt.previewName);
    const st = rt.procs.states().find((p) => p.port === t?.port);
    return st?.status === "running" ? t : null;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
  }
}
