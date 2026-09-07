// One Runtime per worktree: its agent session (from the moment the worktree exists) plus, once
// setup has run, its process group and preview proxy. Replaces the old runtimes + pendingAgents
// pair, which four call sites each had to consult.

import type { ProcState, RepoInfo, WorktreeInfo } from "@toyon/shared";
import { AcpSession } from "../agent/acp/session.ts";
import { spawnAcp } from "../agent/acp/transport.ts";
import type { AgentAdapter } from "../agent/adapter.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import { type ProxyTarget, startProxy, type WorktreeProxy } from "./proxy.ts";
import { WorktreeProcs } from "./supervisor.ts";
import { type TerminalHandle, type TerminalOpts, WorktreeTerminal } from "./terminal.ts";

export interface Runtime {
  info: WorktreeInfo;
  agent: AgentAdapter;
  /** null until start() has run (setup still in progress, or config unconfirmed) */
  procs: WorktreeProcs | null;
  proxy: WorktreeProxy | null;
  previewName: string | undefined;
  /** null until a pane first opens it; survives hiding the pane, dies with the worktree */
  terminal: TerminalHandle | null;
}

export interface RuntimeDeps {
  hub: Hub;
  state: StateStore;
  paths: Paths;
  agents: AgentRegistry;
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
  makeTerminal?: (
    wt: WorktreeInfo,
    opts: TerminalOpts,
    onData: (data: string) => void,
    onExit: (exitCode: number) => void,
  ) => TerminalHandle;
}

/** the sibling-URL variables a proc (or a shell) gets for the procs already up: `<NAME>_URL` and
 * `VITE_<NAME>_URL` per non-preview proc, plus `API_URL` for the one named api */
export function procUrlEnv(states: ProcState[], previewName: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const st of states) {
    if (st.name === previewName) continue;
    const urlVar = `${st.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
    const url = `http://127.0.0.1:${st.port}`;
    env[urlVar] = url;
    env[`VITE_${urlVar}`] = url;
    if (st.name === "api") {
      env.API_URL = url;
      env.VITE_API_URL = url;
    }
  }
  return env;
}

/** a terminal's environment: the daemon's own minus PORT and the supervisor's FORCE_COLOR=0 (a
 * shell wants color and has no port), the sibling URLs, a 256-color TERM, and the worktree id */
export function terminalEnv(
  base: Record<string, string | undefined>,
  wt: WorktreeInfo,
  urls: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string" && k !== "PORT" && k !== "FORCE_COLOR") env[k] = v;
  }
  return { ...env, ...urls, TERM: "xterm-256color", COLORTERM: "truecolor", TOYON_WORKTREE: wt.id };
}

export const DEFAULT_AGENT_ID = "claude";

function defaultAgent(wt: WorktreeInfo, d: RuntimeDeps): AgentAdapter {
  const agent = new AcpSession({
    worktreeId: wt.id,
    cwd: wt.path,
    // resolved at spawn time: a spare is stamped with the task's agent when claimed, and rows from
    // before the registry existed get the default the first time they are used
    spec: () => {
      const w = d.state.requireWorktree(wt.id);
      if (!w.agent) {
        w.agent = d.state.defaultAgent ?? DEFAULT_AGENT_ID;
        d.state.save();
        d.hub.emit("worktreesChanged");
      }
      return d.agents.require(w.agent);
    },
    connect: (app, spec) => spawnAcp(app, d.agents.launch(spec), wt.path, wt.id),
    transcriptsDir: d.paths.transcriptsDir,
    getSessionId: () => d.state.session(wt.id),
    setSessionId: (id) => d.state.setSession(wt.id, id),
    onEvent: (event, seq) => d.hub.emit("agent", wt.id, seq, event),
    onStatus: (status) => d.hub.emit("agentStatus", wt.id, status),
  });
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

function defaultTerminal(
  _wt: WorktreeInfo,
  opts: TerminalOpts,
  onData: (data: string) => void,
  onExit: (exitCode: number) => void,
): TerminalHandle {
  return new WorktreeTerminal(opts, onData, onExit);
}

function defaultProxy(wt: WorktreeInfo, previewName: string | undefined, procs: WorktreeProcs, d: RuntimeDeps) {
  return startProxy({
    port: wt.proxyPort,
    bridgeScript: d.bridgeScript,
    getTarget: () => previewTargetOf(procs, previewName),
  });
}

/** where the proxy forwards: the preview proc unless it crashed (a proc that is still starting is
 * a valid target — the proxy serves its "starting…" page until the port answers) */
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
      terminal: null,
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
    for (const [name, cmd] of Object.entries(procEntries)) {
      if (name !== previewName) await procs.start(name, cmd);
    }
    if (previewName && procEntries[previewName]) {
      await procs.start(previewName, procEntries[previewName]!, procUrlEnv(procs.states(), previewName));
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
    rt.terminal?.kill();
    rt.proxy?.stop();
    await Promise.all([rt.agent.close(), rt.procs?.stopAll()]);
  }

  /** the worktree's shell, spawned on the first open or after it exited; what a fresh pane needs
   * to paint. Resizes before snapshotting: a TUI redraws on SIGWINCH and that redraw arrives as
   * live data after the snapshot, so the pane ends up showing the current screen. */
  openTerminal(id: string, cols: number, rows: number): { snapshot: string; alive: boolean } {
    const wt = this.deps.state.requireWorktree(id);
    if (wt.kind === "spare") throw new UserError("no terminal for a spare worktree");
    const rt = this.ensureAgent(wt);
    let term = rt.terminal;
    if (!term?.alive) {
      // PWD keeps zsh/bash on the logical (title-named) path instead of resolving the link
      const cwd = wt.linkPath ?? wt.path;
      const opts: TerminalOpts = {
        cwd,
        env: { ...terminalEnv(process.env, wt, procUrlEnv(rt.procs?.states() ?? [], rt.previewName)), PWD: cwd },
        cols,
        rows,
        shell: process.env.SHELL || "sh",
        args: ["-l"],
      };
      try {
        term = (this.deps.makeTerminal ?? defaultTerminal)(
          wt,
          opts,
          (data) => this.deps.hub.emit("termData", wt.id, data),
          (code) => this.deps.hub.emit("termExit", wt.id, code),
        );
      } catch (e) {
        throw new UserError(`could not start a shell: ${e instanceof Error ? e.message : String(e)}`);
      }
      rt.terminal = term;
    } else if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows);
    }
    return { snapshot: term.snapshot(), alive: term.alive };
  }

  terminalInput(id: string, data: string) {
    const term = this.runtimes.get(id)?.terminal;
    // a keystroke that lands after the shell exited (or before a pane opened one) is not an error
    if (!term?.alive) return log.debug("terminal", `input for ${id} with no live shell dropped`);
    term.write(data);
  }

  terminalResize(id: string, cols: number, rows: number) {
    this.runtimes.get(id)?.terminal?.resize(cols, rows);
  }

  killTerminal(id: string) {
    this.runtimes.get(id)?.terminal?.kill();
  }

  restartProc(id: string, name: string) {
    this.runtimes.get(id)?.procs?.restart(name);
  }

  recentLogs(id: string): string[] {
    return this.runtimes.get(id)?.procs?.recentLogs() ?? [];
  }

  /** the preview proc only once it answers on its port — for fetching served source (vite-offset) */
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
