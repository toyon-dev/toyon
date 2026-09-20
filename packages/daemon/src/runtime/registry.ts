// One Runtime per worktree: its agent session (from the moment the worktree exists) plus, once
// setup has run, its process group and preview proxy.

import type { LogLine, ProcState, Remote, RepoInfo, WorktreeInfo } from "@toyon/shared";
import { DEFAULT_PERMISSION_MODE, LOGIN_STREAM, SHELL_STREAM } from "@toyon/shared";
import type { AgentAccounts } from "../agent/accounts.ts";
import { OPTION_FIELDS } from "../agent/acp/options.ts";
import { AcpSession } from "../agent/acp/session.ts";
import { spawnAcp } from "../agent/acp/transport.ts";
import type { AgentAdapter, LoginRun } from "../agent/adapter.ts";
import { AttachmentStore } from "../agent/attachments.ts";
import { planEdited, writePlanDoc } from "../agent/planDoc.ts";
import { type PreviewStanding, previewContext } from "../agent/prompt.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import { type PortLease, proxyPorts } from "./ports.ts";
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
  /** the agent's terminal login while it runs, and after it fails so its tab can say why */
  login: { pty: PtyHandle; run: LoginRun } | null;
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
  /** the preview ports; the daemon's own when absent */
  ports?: PortLease;
  /** whether a tab shows the worktree; one shown never gives its preview port up. Absent in tests */
  viewed?: (id: string) => boolean;
  /** whether a tab shows this very row, a spare included: `viewed` counts a spare as shown when a
   * sibling is, which is right for its sleep and wrong for a port it would take from that sibling */
  shown?: (id: string) => boolean;
  /** whether the repo's main checkout is the row new work starts from (no spare stands in for it):
   * main runs only then. One server per repo: the spare is main's running copy, and two of the
   * same code all day was the cost this saves. Absent in tests, where main runs when started. */
  mainLeads?: (repoId: string) => boolean;
  /** factories, overridable so tests run without spawning anything */
  makeAgent?: (wt: WorktreeInfo, deps: RuntimeDeps, preview: () => PreviewStanding | null) => AgentAdapter;
  makeProcs?: (wt: WorktreeInfo, deps: RuntimeDeps) => WorktreeProcs;
  makeProxy?: (
    wt: WorktreeInfo,
    previewName: string | undefined,
    procs: WorktreeProcs,
    deps: RuntimeDeps,
    wake: ProxyWake,
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

/** what every command toyon runs for a worktree can read about where it is: the id, so a project
 * can name a database or a compose project of its own, and the main checkout, so a setup step can
 * copy what git never brings over and toyon does not know to (a local SQLite file, a secrets dir) */
export function worktreeEnv(wt: { id: string }, repo: { path: string }): Record<string, string> {
  return { TOYON_WORKTREE: wt.id, TOYON_ROOT: repo.path };
}

/** a terminal's environment: the daemon's own minus PORT and the supervisor's FORCE_COLOR=0 (a
 * shell wants color and has no port), the sibling URLs, a 256-color TERM, and the worktree's own
 * variables */
export function terminalEnv(
  base: Record<string, string | undefined>,
  own: Record<string, string>,
  urls: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string" && k !== "PORT" && k !== "FORCE_COLOR") env[k] = v;
  }
  return { ...env, ...urls, TERM: "xterm-256color", COLORTERM: "truecolor", ...own };
}

export const DEFAULT_AGENT_ID = "claude";

/** what a proxy tells the registry about requests, and how it waits for a sleeping worktree */
export interface ProxyWake {
  onRequest: () => void;
  ready: () => Promise<ProxyTarget | null>;
}

/** How long a request to a sleeping worktree waits for its dev server before getting the
 * placeholder: past a Vite boot, short of a Next one, which falls back to the placeholder's own
 * refresh. */
const PREVIEW_WAKE_MS = 8_000;
const PREVIEW_POLL_MS = 100;

function defaultAgent(wt: WorktreeInfo, d: RuntimeDeps, preview: () => PreviewStanding | null): AgentAdapter {
  const agent = new AcpSession({
    worktreeId: wt.id,
    cwd: wt.path,
    preview: () => previewContext(preview()),
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
    connect: (app, spec, prepared) => spawnAcp(app, d.agents.launch(spec, prepared), wt.path, wt.id),
    launch: (spec) => d.agents.command(spec),
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
    onPlan: async (markdown) => {
      const w = d.state.worktree(wt.id);
      if (w && !w.planned) {
        w.planned = true;
        d.state.save();
      }
      // an agent that sent no prose has nothing to write; its card is the whole plan
      return markdown.trim() ? writePlanDoc(wt.path, markdown) : null;
    },
    planEdited: async (path, proposed) => planEdited(wt.path, path, proposed),
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

function defaultProxy(
  wt: WorktreeInfo,
  previewName: string | undefined,
  procs: WorktreeProcs,
  d: RuntimeDeps,
  wake: ProxyWake,
) {
  return startProxy({
    port: wt.proxyPort,
    hostname: cloud.bindHost,
    remote: d.remote ?? null,
    grant: d.grant ?? "",
    bridgeScript: d.bridgeScript,
    getTarget: () => previewTargetOf(procs, previewName),
    onRequest: wake.onRequest,
    ready: wake.ready,
  });
}

/** the proc the preview shows: the one named, or the first for a backend-only repo */
function previewProcOf(procs: WorktreeProcs, previewName: string | undefined): ProcState | undefined {
  return procs.states().find((p) => p.name === previewName) ?? procs.states()[0];
}

/** where the proxy forwards: the preview proc once it answers on its port (at the port it actually
 * bound when that differs from the one it was given). Null while it is starting or asleep, so the
 * proxy waits for it rather than forwarding to a port nothing is on yet. */
function previewTargetOf(procs: WorktreeProcs, previewName: string | undefined): ProxyTarget | null {
  const st = previewProcOf(procs, previewName);
  if (st?.status !== "running") return null;
  return { port: st.boundPort ?? st.port, host: st.host ?? "127.0.0.1" };
}

/** the worktree among `ids` a tab showed longest ago; a spare, never shown, goes first */
export function oldestViewed(ids: string[], state: Pick<StateStore, "worktree">): WorktreeInfo | undefined {
  return ids
    .map((id) => state.worktree(id))
    .filter((w): w is WorktreeInfo => w !== undefined)
    .sort((a, b) => (a.viewedAt ?? 0) - (b.viewedAt ?? 0))[0];
}

export class RuntimeRegistry {
  private runtimes = new Map<string, Runtime>();
  /** Shells opened at a discovered worktree's path: a pty, and nothing else around it. There is no
   * Runtime here because there is nothing to run — no procs, no proxy, no agent — and no record to
   * hang one off. Keyed by the discovered id, which is derived from the path, so the same
   * directory keeps its shell across every re-derivation of the list. */
  private looseShells = new Map<string, PtyHandle>();
  /** Outstanding work per worktree, by tag: a turn, a command. A held worktree never sleeps,
   * whether or not anyone is looking at it. */
  private holds = new Map<string, Set<string>>();
  /** worktrees whose deps and setup are still being made: a wake meanwhile would start procs on a
   * half-built tree, and `setupAndStart` starts them itself when it is done */
  private settingUp = new Set<string>();
  /** worktrees whose start() is between its first proc spawn and its proxy */
  private starting = new Set<string>();

  constructor(private deps: RuntimeDeps) {}

  hold(id: string, tag: string): void {
    let tags = this.holds.get(id);
    if (!tags) {
      tags = new Set();
      this.holds.set(id, tags);
    }
    tags.add(tag);
    this.deps.hub.emit("holdsChanged", id, tags.size);
  }

  release(id: string, tag: string): void {
    const tags = this.holds.get(id);
    if (!tags?.delete(tag)) return;
    if (tags.size === 0) this.holds.delete(id);
    this.deps.hub.emit("holdsChanged", id, tags.size);
  }

  holdCount(id: string): number {
    return this.holds.get(id)?.size ?? 0;
  }

  /** Work someone is waiting on: an agent that is not idle or still owes a person something (a
   * message queued, steered or refused, a card open), or a turn or command holding the worktree.
   * What idle sleep, an automatic update and an archive of a worktree's own accord all leave alone. */
  busy(id: string): boolean {
    const agent = this.agentFor(id);
    if (agent && (agent.status !== "idle" || agent.unsettled)) return true;
    return this.holdCount(id) > 0;
  }

  /** whether any worktree is busy */
  anyBusy(): boolean {
    for (const id of this.runtimes.keys()) if (this.busy(id)) return true;
    for (const id of this.holds.keys()) if (this.busy(id)) return true;
    return false;
  }

  markSetup(id: string, on: boolean): void {
    if (on) this.settingUp.add(id);
    else this.settingUp.delete(id);
  }

  /** Bring the worktree's procs up: respawn them if asleep, start them if cold, nothing if they
   * are up or its setup is still running. Every edge that needs a worktree running comes here. */
  async wake(id: string): Promise<void> {
    const wt = this.deps.state.worktree(id);
    if (!wt) return;
    const rt = this.runtimes.get(id);
    if (rt?.procs) {
      if (!rt.procs.asleep) return;
      // a range port went back to sleep; a new one comes with the wake, and the rows frame carries it
      if (!rt.proxy) {
        const live = this.deps.state.requireWorktree(wt.id);
        const port = this.leasePort(live);
        if (port === null) return;
        this.openProxy(rt, live, port);
      }
      rt.procs.wake();
      log.info(id, "awake");
      this.deps.hub.emit("worktreesChanged");
      return;
    }
    if (this.settingUp.has(id)) return;
    const repo = this.deps.state.repos.find((r) => r.id === wt.repoId);
    if (repo) await this.start(wt, repo);
  }

  /** Stop the worktree's procs and nothing else: the proxy, its port, the agent, the shell and
   * the login all stay, so its URL and its terminal are unchanged when it wakes. The one
   * exception is a port from a fixed range: the front forwards a handful, so an asleep copy holding
   * one would keep a copy someone opens from starting, and it gives the port back first. `why` is
   * the reason in the person's words ("nobody looked for 2 h"); it lands on each proc for the
   * boot line, and in the log. */
  async sleep(id: string, why: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt?.procs || rt.procs.asleep) return;
    log.info(id, `asleep: ${why}`);
    if (this.ports.ranged()) {
      rt.proxy?.stop();
      rt.proxy = null;
      this.returnLease(id);
    }
    await rt.procs.sleep(why);
    this.deps.hub.emit("worktreesChanged");
  }

  private get ports(): PortLease {
    return this.deps.ports ?? proxyPorts;
  }

  /** the preview target once its proc answers, or null when nothing is coming: no procs, a proc
   * that crashed, stopped or never answered, or the deadline */
  async awaitPreview(id: string, ms: number): Promise<ProxyTarget | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const rt = this.runtimes.get(id);
      if (!rt?.procs) return null;
      const st = previewProcOf(rt.procs, rt.previewName);
      if (st?.status === "running") return previewTargetOf(rt.procs, rt.previewName);
      // no proc yet while start() is still spawning them counts as starting
      const coming = st ? st.status === "starting" : this.starting.has(id);
      if (!coming || Date.now() >= deadline) return null;
      await Bun.sleep(PREVIEW_POLL_MS);
    }
  }

  /** how many worktrees have procs up, and how many have them asleep, for /health */
  tiers(): { awake: number; asleep: number } {
    let awake = 0;
    let asleep = 0;
    for (const rt of this.runtimes.values()) {
      if (!rt.procs) continue;
      if (rt.procs.asleep) asleep++;
      else awake++;
    }
    return { awake, asleep };
  }

  /** the worktrees whose procs are up, with each one's live process groups, for a cost sample */
  awake(): Array<{ id: string; pgids: number[] }> {
    const out: Array<{ id: string; pgids: number[] }> = [];
    for (const [id, rt] of this.runtimes) {
      if (rt.procs && !rt.procs.asleep) out.push({ id, pgids: rt.procs.pgids() });
    }
    return out;
  }

  isAsleep(id: string): boolean {
    return this.runtimes.get(id)?.procs?.asleep ?? false;
  }

  /** A shell at a path toyon does not run. Same contract as openTerminal's shell branch: spawned
   * on the first open and after it exits, resized before snapshotting so a TUI's redraw lands as
   * live data rather than inside the snapshot. */
  openLooseShell(id: string, cwd: string, cols: number, rows: number): { snapshot: string; alive: boolean } {
    let term = this.looseShells.get(id);
    if (!term?.alive) {
      const opts: PtyOpts = {
        cwd,
        // a discovered worktree has no repo record, so no TOYON_ROOT to give it
        env: { ...terminalEnv(process.env, { TOYON_WORKTREE: id }, {}), PWD: cwd },
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
      agent: (this.deps.makeAgent ?? defaultAgent)(wt, this.deps, () => this.previewStanding(wt.id)),
      procs: null,
      proxy: null,
      previewName: undefined,
      shell: null,
      login: null,
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
    // main's copy of the app is the spare's while there is one; main itself runs only as the lead
    // (setup unconfirmed, an empty project, a warm-up that failed), which keeps the setup pane and
    // the first-run preview working
    if (wt.kind === "main" && this.deps.mainLeads && !this.deps.mainLeads(wt.repoId)) return;

    // before anything starts, so running out of preview ports leaves nothing half up. The record
    // keeps the port it got, and the rows frame sent once the proxy is up carries it to the shell
    const live = this.deps.state.requireWorktree(wt.id);
    const port = this.leasePort(live);
    if (port === null) return;

    const procs = (this.deps.makeProcs ?? defaultProcs)(wt, this.deps);
    rt.procs = procs;
    // unconfirmed detection: no procs until the user confirms the setup pane
    const run = repo.needsSetup ? { procs: {}, env: {}, preview: undefined } : resolveRun(repo, wt);
    const previewName = run.preview;
    rt.previewName = previewName;

    // start non-preview procs first so the preview proc can get their URLs. Every proc gets the
    // profile env; a `$API_URL` in it resolves against whatever siblings are already up, so the
    // api proc itself sees it unexpanded and the preview proc sees the address. The worktree's own
    // variables ride along, and the profile env may reference them the same way it references a
    // sibling's URL
    const envFor = () => {
      const urls = { ...procUrlEnv(procs.states(), previewName), ...worktreeEnv(wt, repo) };
      return { ...urls, ...expandEnv(run.env, urls) };
    };
    this.starting.add(wt.id);
    try {
      for (const [name, cmd] of Object.entries(run.procs)) {
        if (name !== previewName) await procs.start(name, cmd, envFor());
      }
      if (previewName && run.procs[previewName]) {
        await procs.start(previewName, run.procs[previewName]!, envFor());
      }
    } finally {
      this.starting.delete(wt.id);
    }

    if (!this.deps.state.worktree(wt.id) || this.runtimes.get(wt.id) !== rt) {
      // removed while the procs were starting: don't leave them running
      this.returnLease(wt.id);
      await procs.stopAll();
      return;
    }
    this.openProxy(rt, live, port);
    this.deps.hub.emit("worktreesChanged");
  }

  /** the proxy on the port just leased; the record keeps the port, and the rows frame sent once
   * the proxy is up carries it to the shell */
  private openProxy(rt: Runtime, live: WorktreeInfo, port: number) {
    if (port !== live.proxyPort) {
      live.proxyPort = port;
      this.deps.state.save();
    }
    const procs = rt.procs!;
    rt.proxy = (this.deps.makeProxy ?? defaultProxy)(live, rt.previewName, procs, this.deps, {
      // a request is someone using the preview: the worktree wakes for it, and the policy that
      // decides when it sleeps hears about it
      onRequest: () => {
        this.deps.hub.emit("previewRequest", live.id);
        fireAndForget(live.id, this.wake(live.id), "wake on request");
      },
      ready: () => this.awaitPreview(live.id, PREVIEW_WAKE_MS),
    });
  }

  /** the preview port each worktree holds while its proxy is up, returned when it stops */
  private leased = new Map<string, number>();

  /** A port for the copy coming up. When running copies hold every port in the range, the one
   * looked at longest ago goes to sleep and its port comes here; opening it again takes one back
   * the same way. Nothing being looked at or worked on gives its port up, and a spare nobody is
   * looking at takes no one's: it stays cold, with nothing to tell. A spare a tab shows is the
   * plus, and leases like any shown row, or a full range on a remote would leave the plus on a
   * warming pane with no way out. Synchronous up to the lease, so two starts at once never pick
   * the same copy or the same port. */
  private leasePort(wt: WorktreeInfo): number | null {
    let port = this.ports.lease(wt.proxyPort);
    if (port === null && (wt.kind !== "spare" || this.deps.shown?.(wt.id))) {
      const holders = [...this.leased.keys()].filter(
        (id) => id !== wt.id && !this.starting.has(id) && !this.busy(id) && !this.deps.viewed?.(id),
      );
      const victim = oldestViewed(holders, this.deps.state);
      if (victim) {
        // the proxy and the lease go before the first await inside, which is all the port needs
        fireAndForget(
          victim.id,
          this.sleep(victim.id, `its preview port went to ${wt.title || wt.branch}`),
          "sleep for a preview port",
        );
        port = this.ports.lease(wt.proxyPort);
      }
      if (port === null) {
        throw new UserError(`all preview ports ${this.ports.label()} are in use by running copies; stop one first`);
      }
    }
    if (port !== null) this.leased.set(wt.id, port);
    return port;
  }

  private returnLease(id: string) {
    const port = this.leased.get(id);
    if (port === undefined) return;
    this.leased.delete(id);
    this.ports.release(port);
  }

  /** stop procs and proxy but keep the agent (config confirmed → restart under the new config) */
  async stopProcs(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const { procs, proxy } = rt;
    rt.procs = null;
    rt.proxy = null;
    proxy?.stop();
    this.returnLease(id);
    await procs?.stopAll();
  }

  /** stop everything for a worktree and forget it */
  async stop(id: string): Promise<void> {
    this.holds.delete(id);
    this.settingUp.delete(id);
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.runtimes.delete(id);
    rt.proxy?.stop();
    this.returnLease(id);
    const login = rt.login;
    rt.login = null;
    await Promise.all([rt.agent.close(), rt.procs?.stopAll(), rt.shell?.kill(), login?.pty.kill()]);
  }

  /** one of the worktree's streams: its shell (spawned on the first open or after it exited) or a
   * proc, which the supervisor already has running. What a fresh tab needs to paint. Resizes
   * before snapshotting: a TUI redraws on SIGWINCH and that redraw arrives as live data after the
   * snapshot, so the tab ends up showing the current screen. */
  openTerminal(id: string, stream: string, cols: number, rows: number): { snapshot: string; alive: boolean } {
    if (stream === LOGIN_STREAM) return this.openLoginStream(id, cols, rows);
    if (stream !== SHELL_STREAM) return this.openProcStream(id, stream, cols, rows);
    const wt = this.deps.state.requireWorktree(id);
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
    return { snapshot: term.snapshot(), alive: term.alive };
  }

  /** Run the agent's terminal login as the worktree's login stream. A process of its own rather
   * than a line typed into the shell, so its exit is known: a clean one tells the agent it is logged
   * in, which closes the card and sends the refused message again, and any other leaves the tab
   * showing why. It starts before a pane opens, and the tab replays what it printed. A second
   * start replaces the first. */
  startLogin(id: string, run: LoginRun): void {
    const wt = this.deps.state.requireWorktree(id);
    const rt = this.ensureAgent(wt);
    const prev = rt.login;
    rt.login = null;
    if (prev) fireAndForget(id, Promise.resolve(prev.pty.kill()), "replace the agent login");
    const cwd = wt.linkPath ?? wt.path;
    let pty: PtyHandle;
    try {
      pty = (this.deps.makeTerminal ?? defaultTerminal)(
        wt,
        {
          cwd,
          env: { ...this.shellEnv(wt), ...run.env, PWD: cwd },
          cols: 100,
          rows: 30,
          file: run.command,
          args: run.args,
        },
        (data) => this.deps.hub.emit("termData", id, LOGIN_STREAM, data),
        (code) => {
          this.deps.hub.emit("termExit", id, LOGIN_STREAM, code);
          // a login that was replaced, or whose worktree went away, says nothing about credentials
          if (rt.login?.pty !== pty) return;
          if (code === 0) {
            rt.login = null;
            rt.agent.loggedIn();
          }
          this.deps.hub.emit("worktreesChanged");
        },
      );
    } catch (e) {
      throw new UserError(`could not start the login: ${e instanceof Error ? e.message : String(e)}`);
    }
    rt.login = { pty, run };
    this.deps.hub.emit("worktreesChanged");
  }

  /** the login tab attaches to the login running, or to the one that failed */
  private openLoginStream(id: string, cols: number, rows: number): { snapshot: string; alive: boolean } {
    const pty = this.runtimes.get(id)?.login?.pty;
    if (!pty) return { snapshot: "", alive: false };
    if (pty.cols !== cols || pty.rows !== rows) pty.resize(cols, rows);
    return { snapshot: pty.snapshot(), alive: pty.alive };
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
    const repo = this.deps.state.requireRepo(wt.repoId);
    return terminalEnv(process.env, worktreeEnv(wt, repo), procUrlEnv(rt?.procs?.states() ?? [], rt?.previewName));
  }

  terminalInput(id: string, stream: string, data: string) {
    const rt = this.runtimes.get(id);
    if (stream === LOGIN_STREAM) return rt?.login?.pty.write(data);
    if (stream !== SHELL_STREAM) return rt?.procs?.write(stream, data);
    // a keystroke that lands after the shell exited (or before a pane opened one) is not an error
    if (!rt?.shell?.alive) return log.debug("terminal", `input for ${id} with no live shell dropped`);
    rt.shell.write(data);
  }

  terminalResize(id: string, stream: string, cols: number, rows: number) {
    const rt = this.runtimes.get(id);
    if (stream === SHELL_STREAM) rt?.shell?.resize(cols, rows);
    else if (stream === LOGIN_STREAM) rt?.login?.pty.resize(cols, rows);
    else rt?.procs?.resize(stream, cols, rows);
  }

  /** restart a stream: a proc goes back under supervision, the shell dies and the tab reopens it,
   * and the login runs again */
  async restartStream(id: string, stream: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (stream === LOGIN_STREAM) {
      if (rt?.login) this.startLogin(id, rt.login.run);
    } else if (stream === SHELL_STREAM) await rt?.shell?.kill();
    // asleep, the restart someone asked for in a proc's tab is the wake of the whole set
    else if (rt?.procs?.asleep) await this.wake(id);
    else rt?.procs?.restart(stream);
  }

  recentLogs(id: string): LogLine[] {
    return this.runtimes.get(id)?.procs?.recentLogs() ?? [];
  }

  /** the preview proc only once it answers on its port — for fetching served source (vite-offset) */
  previewTarget(id: string): ProxyTarget | null {
    const rt = this.runtimes.get(id);
    return rt?.procs ? previewTargetOf(rt.procs, rt.previewName) : null;
  }

  /** where the preview stands, for the block the agent reads with every message: its status and
   * the address it answers (or will answer) at, "setup" while the tree is still being made, null
   * when there is nothing to run here or nothing confirmed yet */
  previewStanding(id: string): PreviewStanding | null {
    if (this.settingUp.has(id)) return { status: "setup" };
    const rt = this.runtimes.get(id);
    if (!rt?.procs) return null;
    const st = previewProcOf(rt.procs, rt.previewName);
    if (!st) return null;
    // a proc that ignored $PORT answers where it bound; a server on ::1 alone needs the brackets
    const host = st.host ?? "127.0.0.1";
    const url = `http://${host.includes(":") ? `[${host}]` : host}:${st.boundPort ?? st.port}`;
    return { status: st.status, url, ...(st.detail ? { detail: st.detail } : {}) };
  }

  async shutdown(): Promise<void> {
    this.pruneLooseShells(new Set());
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
  }
}
