// One Runtime per worktree: its agent session (from the moment the worktree exists) plus, once
// setup has run, its process group and preview proxy.

import type { LogLine, ProcState, Remote, RepoInfo, WorktreeInfo } from "@toyon/shared";
import { DEFAULT_PERMISSION_MODE, SHELL_STREAM } from "@toyon/shared";
import type { AgentAccounts } from "../agent/accounts.ts";
import { OPTION_FIELDS } from "../agent/acp/options.ts";
import { AcpSession } from "../agent/acp/session.ts";
import { spawnAcp } from "../agent/acp/transport.ts";
import type { AgentAdapter } from "../agent/adapter.ts";
import { AttachmentStore } from "../agent/attachments.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import { expandEnv, resolveRun } from "./profile.ts";
import { type ProxyTarget, startProxy, type WorktreeProxy } from "./proxy.ts";
import { type PtyHandle, type PtyOpts, PtyStream } from "./pty.ts";
import { WorktreeProcs } from "./supervisor.ts";

export interface Runtime {
  info: WorktreeInfo;
  agent: AgentAdapter;
  /** null until start() has run (setup still in progress, or config unconfirmed) */
  procs: WorktreeProcs | null;
  proxy: WorktreeProxy | null;
  previewName: string | undefined;
  /** null until a pane first opens it; survives hiding the pane, dies with the worktree */
  shell: PtyHandle | null;
  /** a command line to type into the shell once a pane opens one (agent login) */
  pendingLine: string | null;
}

export interface RuntimeDeps {
  hub: Hub;
  state: StateStore;
  paths: Paths;
  agents: AgentRegistry;
  /** told what each agent session learns about its agent's credentials; absent in tests */
  accounts?: AgentAccounts;
  /** shared with the http layer that serves the images back; built from paths when absent */
  attachments?: AttachmentStore;
  bridgeScript: () => string;
  /** the public name a front may forward preview ports under, and the grant they take
   * (core/remote.ts); absent in tests, where previews answer loopback only */
  remote?: Remote | null;
  grant?: string;
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
    /** only the id is used, so a loose shell (no worktree record) can pass its discovered id */
    wt: { id: string },
    opts: PtyOpts,
    onData: (data: string) => void,
    onExit: (exitCode: number) => void,
  ) => PtyHandle;
}

/** the sibling-URL variables a proc (or a shell) gets for the procs already up: `<NAME>_URL` and
 * `VITE_<NAME>_URL` per non-preview proc, plus `API_URL` for the one named api */
export function procUrlEnv(states: ProcState[], previewName: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const st of states) {
    if (st.name === previewName) continue;
    const urlVar = `${st.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
    // a proc that ignored $PORT is reachable where it actually bound, not where it was told to
    const url = `http://127.0.0.1:${st.boundPort ?? st.port}`;
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
  wt: { id: string },
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
    launch: (spec) => d.agents.launch(spec),
    transcriptsDir: d.paths.transcriptsDir,
    attachments: d.attachments ?? new AttachmentStore(d.paths.attachmentsDir),
    getSessionId: () => d.state.session(wt.id),
    setSessionId: (id) => d.state.setSession(wt.id, id),
    onEvent: (event, seq) => d.hub.emit("agent", wt.id, seq, event),
    onStatus: (status) => d.hub.emit("agentStatus", wt.id, status),
    onAuth: (agentId, o) => d.accounts?.observe(agentId, o),
    // read at call time, for the same reason as `spec`
    seedCommands: () => d.state.cachedCommands(d.state.requireWorktree(wt.id).agent ?? "", wt.repoId),
    onCommandsLearned: (commands) =>
      d.state.setCachedCommands(d.state.requireWorktree(wt.id).agent ?? "", wt.repoId, commands),
    // the record, read fresh: the composer changes it between turns and a plan approval sets it
    mode: () => d.state.requireWorktree(wt.id).mode ?? DEFAULT_PERMISSION_MODE,
    setMode: (mode) => {
      const w = d.state.requireWorktree(wt.id);
      if (w.mode === mode) return;
      w.mode = mode;
      d.state.save();
      d.hub.emit("worktreesChanged");
    },
    option: (category) => d.state.requireWorktree(wt.id)[OPTION_FIELDS[category]],
    // kept per agent, not per worktree: the picker on a worktree whose session has not opened
    // yet shows what this agent offered last time
    onOptionsLearned: (category, choices) => {
      const agentId = d.state.requireWorktree(wt.id).agent ?? "";
      if (d.state.setCachedOptions(agentId, category, choices)) d.hub.emit("agentsChanged");
    },
  });
  agent.onQueueChange = () => d.hub.emit("queue", wt.id, agent.queueItems);
  agent.onCommandsChange = (commands) => d.hub.emit("agentCommands", wt.id, commands);
  return agent;
}

function defaultProcs(wt: WorktreeInfo, d: RuntimeDeps): WorktreeProcs {
  return new WorktreeProcs(
    wt.path,
    (p) => d.hub.emit("proc", wt.id, p),
    (proc, line) => d.hub.emit("log", wt.id, proc, line),
    (proc, data) => d.hub.emit("termData", wt.id, proc, data),
    (proc, code) => d.hub.emit("termExit", wt.id, proc, code),
  );
}

function defaultTerminal(
  _wt: { id: string },
  opts: PtyOpts,
  onData: (data: string) => void,
  onExit: (exitCode: number) => void,
): PtyHandle {
  return new PtyStream(opts, onData, onExit);
}

function defaultProxy(wt: WorktreeInfo, previewName: string | undefined, procs: WorktreeProcs, d: RuntimeDeps) {
  return startProxy({
    port: wt.proxyPort,
    hostname: cloud.bindHost,
    remote: d.remote ?? null,
    grant: d.grant ?? "",
    bridgeScript: d.bridgeScript,
    getTarget: () => previewTargetOf(procs, previewName),
  });
}

/** where the proxy forwards: the preview proc unless it crashed or never came up (a proc that is
 * still starting is a valid target — the proxy serves its "starting…" page until the port answers),
 * at the port it actually bound when that differs from the one it was given */
function previewTargetOf(procs: WorktreeProcs, previewName: string | undefined): ProxyTarget | null {
  const st =
    procs.states().find((p) => p.name === previewName) ??
    // backend-only repo: point preview at the first proc
    procs.states()[0];
  if (!st || st.status === "crashed" || st.status === "unreachable") return null;
  return { port: st.boundPort ?? st.port, host: st.host ?? "127.0.0.1" };
}

export class RuntimeRegistry {
  private runtimes = new Map<string, Runtime>();
  /** Shells opened at a discovered worktree's path: a pty, and nothing else around it. There is no
   * Runtime here because there is nothing to run — no procs, no proxy, no agent — and no record to
   * hang one off. Keyed by the discovered id, which is derived from the path, so the same
   * directory keeps its shell across every re-derivation of the list. */
  private looseShells = new Map<string, PtyHandle>();

  constructor(private deps: RuntimeDeps) {}

  /** A shell at a path toyon does not run. Same contract as openTerminal's shell branch: spawned
   * on the first open and after it exits, resized before snapshotting so a TUI's redraw lands as
   * live data rather than inside the snapshot. */
  openLooseShell(id: string, cwd: string, cols: number, rows: number): { snapshot: string; alive: boolean } {
    let term = this.looseShells.get(id);
    if (!term?.alive) {
      const opts: PtyOpts = {
        cwd,
        env: { ...terminalEnv(process.env, { id }, {}), PWD: cwd },
        cols,
        rows,
        file: process.env.SHELL || "sh",
        args: ["-l"],
      };
      try {
        term = (this.deps.makeTerminal ?? defaultTerminal)(
          { id },
          opts,
          (data) => this.deps.hub.emit("termData", id, SHELL_STREAM, data),
          (code) => this.deps.hub.emit("termExit", id, SHELL_STREAM, code),
        );
      } catch (e) {
        throw new UserError(`could not start a shell: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.looseShells.set(id, term);
    } else if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows);
    }
    return { snapshot: term.snapshot(), alive: term.alive };
  }

  looseShell(id: string): PtyHandle | undefined {
    return this.looseShells.get(id);
  }

  /** Kill shells whose directory is no longer a discovered worktree: it was taken over, removed,
   * or the repo was forgotten. Called after every derivation, so the set is the current truth. */
  pruneLooseShells(keep: Set<string>): void {
    for (const [id, term] of this.looseShells) {
      if (keep.has(id)) continue;
      this.looseShells.delete(id);
      fireAndForget(id, Promise.resolve(term.kill()), "loose shell cleanup");
    }
  }

  get(id: string): Runtime | undefined {
    return this.runtimes.get(id);
  }

  /** worktrees with procs up. Spares are left out to match the worktree count the shell shows;
   * `info` is the live state record, so a claimed spare counts from the moment its kind changes. */
  runningCount(): number {
    let n = 0;
    for (const rt of this.runtimes.values()) if (rt.procs && rt.info.kind !== "spare") n++;
    return n;
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
      shell: null,
      pendingLine: null,
    };
    this.runtimes.set(wt.id, rt);
    return rt;
  }

  /** start the worktree's procs and proxy under the repo's config, narrowed by the worktree's
   * profile; no-op if already running */
  async start(wt: WorktreeInfo, repo: RepoInfo): Promise<void> {
    if (!this.deps.state.worktree(wt.id)) return; // removed while setup was running
    const rt = this.ensureAgent(wt);
    if (rt.procs) return;

    const procs = (this.deps.makeProcs ?? defaultProcs)(wt, this.deps);
    rt.procs = procs;
    // unconfirmed detection: no procs until the user confirms the setup pane
    const run = repo.needsSetup ? { procs: {}, env: {}, preview: undefined } : resolveRun(repo, wt);
    const previewName = run.preview;
    rt.previewName = previewName;

    // start non-preview procs first so the preview proc can get their URLs. Every proc gets the
    // profile env; a `$API_URL` in it resolves against whatever siblings are already up, so the
    // api proc itself sees it unexpanded and the preview proc sees the address. The worktree id
    // rides along so a proc can name a database or a compose project of its own; the profile env
    // may reference it the same way it references a sibling's URL
    const envFor = () => {
      const urls = { ...procUrlEnv(procs.states(), previewName), TOYON_WORKTREE: wt.id };
      return { ...urls, ...expandEnv(run.env, urls) };
    };
    for (const [name, cmd] of Object.entries(run.procs)) {
      if (name !== previewName) await procs.start(name, cmd, envFor());
    }
    if (previewName && run.procs[previewName]) {
      await procs.start(previewName, run.procs[previewName]!, envFor());
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
    rt.proxy?.stop();
    await Promise.all([rt.agent.close(), rt.procs?.stopAll(), rt.shell?.kill()]);
  }

  /** one of the worktree's streams: its shell (spawned on the first open or after it exited) or a
   * proc, which the supervisor already has running. What a fresh tab needs to paint. Resizes
   * before snapshotting: a TUI redraws on SIGWINCH and that redraw arrives as live data after the
   * snapshot, so the tab ends up showing the current screen. */
  openTerminal(id: string, stream: string, cols: number, rows: number): { snapshot: string; alive: boolean } {
    if (stream !== SHELL_STREAM) return this.openProcStream(id, stream, cols, rows);
    const wt = this.deps.state.requireWorktree(id);
    if (wt.kind === "spare") throw new UserError("no terminal for a spare worktree");
    const rt = this.ensureAgent(wt);
    let term = rt.shell;
    if (!term?.alive) {
      // PWD keeps zsh/bash on the logical (title-named) path instead of resolving the link
      const cwd = wt.linkPath ?? wt.path;
      const opts: PtyOpts = {
        cwd,
        env: { ...this.shellEnv(wt), PWD: cwd },
        cols,
        rows,
        file: process.env.SHELL || "sh",
        args: ["-l"],
      };
      try {
        term = (this.deps.makeTerminal ?? defaultTerminal)(
          wt,
          opts,
          (data) => this.deps.hub.emit("termData", wt.id, SHELL_STREAM, data),
          (code) => this.deps.hub.emit("termExit", wt.id, SHELL_STREAM, code),
        );
      } catch (e) {
        throw new UserError(`could not start a shell: ${e instanceof Error ? e.message : String(e)}`);
      }
      rt.shell = term;
    } else if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows);
    }
    if (rt.pendingLine) {
      // after the shell has printed its prompt, so the line reads as typed rather than pasted first
      const line = rt.pendingLine;
      rt.pendingLine = null;
      const t = term;
      setTimeout(() => t.alive && t.write(`${line}\r`), 300);
    }
    return { snapshot: term.snapshot(), alive: term.alive };
  }

  /** a proc's stream: the supervisor owns it, so a tab only attaches to what is already running */
  private openProcStream(id: string, stream: string, cols: number, rows: number): { snapshot: string; alive: boolean } {
    const procs = this.runtimes.get(id)?.procs;
    const pty = procs?.stream(stream);
    // a tab can open before its proc has spawned (setup still running, or mid-restart): an empty
    // snapshot is right, and the tab fills in when the proc starts streaming
    if (!pty) return { snapshot: "", alive: false };
    if (pty.cols !== cols || pty.rows !== rows) procs?.resize(stream, cols, rows);
    return { snapshot: pty.snapshot(), alive: pty.alive };
  }

  /** what a shell run on the worktree's behalf sees: the daemon's environment plus the sibling
   * URLs of whatever procs are up. The shell tab and a `!` command from the composer get the
   * same one, so `curl $API_URL` means the same thing typed in either. */
  shellEnv(wt: WorktreeInfo): Record<string, string> {
    const rt = this.runtimes.get(wt.id);
    return terminalEnv(process.env, wt, procUrlEnv(rt?.procs?.states() ?? [], rt?.previewName));
  }

  /** type a command into the worktree's shell: now if a pane has one open, else when one opens */
  terminalLine(id: string, line: string) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    if (rt.shell?.alive) rt.shell.write(`${line}\r`);
    else rt.pendingLine = line;
  }

  terminalInput(id: string, stream: string, data: string) {
    const rt = this.runtimes.get(id);
    if (stream !== SHELL_STREAM) return rt?.procs?.write(stream, data);
    // a keystroke that lands after the shell exited (or before a pane opened one) is not an error
    if (!rt?.shell?.alive) return log.debug("terminal", `input for ${id} with no live shell dropped`);
    rt.shell.write(data);
  }

  terminalResize(id: string, stream: string, cols: number, rows: number) {
    const rt = this.runtimes.get(id);
    if (stream === SHELL_STREAM) rt?.shell?.resize(cols, rows);
    else rt?.procs?.resize(stream, cols, rows);
  }

  /** restart a stream: a proc goes back under supervision, the shell dies and the tab reopens it */
  async restartStream(id: string, stream: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (stream === SHELL_STREAM) await rt?.shell?.kill();
    else rt?.procs?.restart(stream);
  }

  recentLogs(id: string): LogLine[] {
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
    this.pruneLooseShells(new Set());
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
  }
}
