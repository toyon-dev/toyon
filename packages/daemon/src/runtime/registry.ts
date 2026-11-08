// One Runtime per worktree: its agent session (from the moment the worktree exists) plus, once
// setup has run, its process group and preview proxy.

import { existsSync } from "node:fs";
import type {
  ArchivedWorktree,
  Borrowed,
  LogLine,
  ManagedPolicy,
  ProcState,
  Remote,
  RepoInfo,
  WorktreeInfo,
  WorktreeKind,
} from "@toyon/shared";
import { addressedByPort, DEFAULT_PERMISSION_MODE, LOGIN_STREAM, PREVIEW_PORTS, SHELL_STREAM } from "@toyon/shared";
import { OPTION_FIELDS } from "../agent/acp/options.ts";
import { AcpSession } from "../agent/acp/session.ts";
import { spawnAcp } from "../agent/acp/transport.ts";
import type { AgentAdapter, LoginRun } from "../agent/adapter.ts";
import { AttachmentStore } from "../agent/attachments.ts";
import type { ToyonMcp } from "../agent/mcp.ts";
import { commandFolders, readCommandOrigins } from "../agent/origins.ts";
import { listDoc, ownPlanPath, planEdited, writePlanDoc, writePlanDocNow } from "../agent/planDoc.ts";
import {
  type PreviewStanding,
  previewContext,
  selfContext,
  standingContext,
  type TierStanding,
  tierContext,
  type WorkStanding,
  worktreeContext,
} from "../agent/prompt.ts";
import type { AgentReadiness } from "../agent/readiness.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { transcriptPathFor } from "../agent/transcript.ts";
import { UploadStore } from "../agent/uploads.ts";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { PreviewGate } from "../core/remote.ts";
import type { GroupEntry, StateStore } from "../core/state.ts";
import { configFor, settingsLines, type WorktreeConfig } from "../repos/config.ts";
import { watchConfigFile } from "../repos/watcher.ts";
import { type ForwardOpts, type ForwardTarget, type ProcForwarder, startForward } from "./forward.ts";
import { groupAlive, reclaimGroup } from "./kill.ts";
import { bootId, type PsRow, psGroups } from "./memory.ts";
import { type Orphan, orphansIn, strayAdapters, strayProcs } from "./orphans.ts";
import { type PortLease, proxyPorts } from "./ports.ts";
import { EMPTY_RUN, type ResolvedRun, resolveRun, spawnsOf } from "./profile.ts";
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
  /** the settings the procs came up under, and the run resolved from them: what a take-over
   * starts a proc with, so a file edited under running procs cannot give one a command its
   * siblings did not start with. Gone with the procs. */
  cfg: WorktreeConfig | null;
  run: ResolvedRun | null;
  /** the worktree's own settings file, watched while its procs run; main's is the repo's watcher */
  configWatch: (() => void) | null;
  /** one per non-preview proc, by name: the fixed address its siblings and the shell reach it
   * at. Bound before any proc spawns, kept through sleep, gone with the procs. */
  forwards: Map<string, ProcForwarder>;
  /** the shared tier of the run in effect: what main runs for everyone */
  shared: Set<string>;
  /** the shared procs this worktree reaches on main rather than running; shrinks as it takes
   * them over, and is empty on main */
  borrowed: Set<string>;
  /** proc -> the remote URL its page reaches instead of main's or its own; empty on main */
  pointed: Map<string, string>;
  /** pointed procs whose files this worktree has changed since: the page is not talking to those
   * edits. Set by the flip's check, cleared by a take-over, a repoint or a stop. */
  remoteBehind: Set<string>;
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
  /** a worktree's agent is about to be sent a turn; awaited before the prompt goes. Absent in tests */
  turnStarting?: (worktreeId: string) => Promise<void>;
  /** what the managed policy lets an agent session offer; everything when absent (tests) */
  managed?: Pick<ManagedPolicy, "planSignIn">;
  /** told what each agent session learns about its agent's credentials; absent in tests */
  readiness?: AgentReadiness;
  /** shared with the http layer that serves the images back; built from paths when absent */
  attachments?: AttachmentStore;
  bridgeScript: () => string;
  /** the paragraph behind a message that says what the worktree's preview page has thrown since
   * it last loaded, read as the message goes out; absent in tests */
  pageErrors?: (worktreeId: string) => string | undefined;
  /** a project's archived worktrees, newest first, for a message that names one by its branch;
   * read as the message goes out. Absent in tests, where only open rows can be named */
  archived?: (repoId: string) => ArchivedWorktree[];
  /** where a worktree's work stands (its tree read now, its landed and PR marks), for the
   * paragraph behind every message; absent in tests */
  standing?: (worktreeId: string) => Promise<WorkStanding | null>;
  /** what the worktree borrows, owns and points away, for the paragraph behind every message;
   * absent in tests that have no tier */
  tier?: (worktreeId: string) => TierStanding | null;
  /** the public name a front may forward preview ports under, and the gate they check
   * (core/remote.ts), as they stand now; absent in tests, where previews answer loopback only */
  remote?: () => Remote | null;
  gate?: () => PreviewGate | null;
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
  /** the boot id and the process table, for the reclaim at boot; the machine's own when absent */
  machine?: { bootId: () => Promise<string | null>; psGroups: () => Promise<PsRow[]> };
  /** kills a group another daemon left; the real signal when absent */
  reclaim?: (pgid: number) => Promise<void>;
  /** whether anything in a process group still answers a signal; the real check when absent */
  groupAlive?: (pgid: number) => boolean;
  /** Toyon's own tools for each worktree's agent, over MCP (agent/mcp.ts); absent in tests */
  mcp?: Pick<ToyonMcp, "open" | "close">;
  /** factories, overridable so tests run without spawning anything. `onProcess` is told when the
   * agent's process group comes up or goes, so the ledger follows it. */
  makeAgent?: (
    wt: WorktreeInfo,
    deps: RuntimeDeps,
    preview: () => PreviewStanding | null,
    onProcess: () => void,
  ) => AgentAdapter;
  makeProcs?: (wt: WorktreeInfo, deps: RuntimeDeps) => WorktreeProcs;
  makeForward?: (opts: ForwardOpts) => ProcForwarder;
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

/** the variable a proc's address is read from: `<NAME>_URL`, and `API_URL` for the one named api */
export function urlVarOf(name: string): string {
  return name === "api" ? "API_URL" : `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
}

/** the sibling-URL variables a proc (or a shell) gets: `<NAME>_URL` and `VITE_<NAME>_URL` per
 * non-preview proc, plus `API_URL` for the one named api. A proc with a forwarder is reached
 * there, whether or not it is up yet; one the page points at a remote is reached at that URL;
 * one with neither is reached where it runs, once it does. */
export function procUrlEnv(
  states: ProcState[],
  previewName: string | undefined,
  forwards: ReadonlyMap<string, number> = new Map(),
  remotes: ReadonlyMap<string, string> = new Map(),
): Record<string, string> {
  const env: Record<string, string> = {};
  const add = (name: string, url: string) => {
    const urlVar = `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
    env[urlVar] = url;
    env[`VITE_${urlVar}`] = url;
    if (name === "api") {
      env.API_URL = url;
      env.VITE_API_URL = url;
    }
  };
  for (const [name, port] of forwards) add(name, `http://127.0.0.1:${port}`);
  for (const [name, url] of remotes) add(name, url);
  for (const st of states) {
    if (st.name === previewName || forwards.has(st.name) || remotes.has(st.name)) continue;
    // a proc that ignored $PORT is reachable where it actually bound, not where it was told to
    add(st.name, `http://127.0.0.1:${st.boundPort ?? st.port}`);
  }
  return env;
}

/** What every command toyon runs for a worktree can read about where it is: the id, so a project
 * can name a database or a compose project of its own, and the main checkout, so a setup step can
 * copy what git never brings over and toyon does not know to (a local SQLite file, a secrets dir).
 * On main the id is empty: main never runs setup, so nothing named for an id exists there, and
 * `app${TOYON_WORKTREE:+_$TOYON_WORKTREE}` names the base database on main and a copy's own
 * everywhere else. */
export function worktreeEnv(wt: { id: string; kind?: WorktreeKind }, repo: { path: string }): Record<string, string> {
  return { TOYON_WORKTREE: wt.kind === "main" ? "" : wt.id, TOYON_ROOT: repo.path };
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

export { DEFAULT_AGENT_ID } from "../agent/registry.ts";

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
/** how long a proc a worktree takes over from main may take to answer: the supervisor's own ceiling */
const PROC_UP_MS = 60_000;

/** The agent a row with none on its record runs, stamped the first time it is used: rows from
 * before the registry existed, and a main on its first chat. With what the composer picked for new
 * worktrees of it, except on a spare: the claim stamps the task's own picks and skips a field the
 * task left empty, so a pick written here would outlive being cleared before the send. */
export function stampAgent(id: string, d: Pick<RuntimeDeps, "state" | "agents" | "hub">) {
  const w = d.state.requireWorktree(id);
  if (!w.agent) {
    w.agent = d.agents.defaultId(d.state.defaultAgent);
    if (w.kind !== "spare") Object.assign(w, d.state.fillPicks(w.agent, { model: w.model, effort: w.effort }));
    d.state.save();
    d.hub.emit("worktreesChanged");
  }
  return d.agents.require(w.agent);
}

function defaultAgent(
  wt: WorktreeInfo,
  d: RuntimeDeps,
  preview: () => PreviewStanding | null,
  onProcess: () => void,
): AgentAdapter {
  const mcp = d.mcp;
  // resolved at spawn time: a spare is stamped with the task's agent when claimed
  const spec = () => stampAgent(wt.id, d);
  const agent = new AcpSession({
    worktreeId: wt.id,
    cwd: wt.path,
    preview: () => previewContext(preview()),
    tier: () => tierContext(d.tier?.(wt.id) ?? null),
    // the live record, not `wt`: the title and branch move after the session is made
    self: () => {
      const w = d.state.worktrees.find((w) => w.id === wt.id);
      return w ? selfContext(w) : undefined;
    },
    standing: async () => standingContext((await d.standing?.(wt.id)) ?? null),
    pageErrors: () => d.pageErrors?.(wt.id),
    // the project's other worktrees, open ones first and then the archive, read as the message
    // goes out: a row made or archived since the session opened is one the message can name. The
    // archive is newest first, so a branch reused and archived twice names its latest chat. The
    // same set, in the same order, as the shell marks (chat/Mentions.tsx), so a word drawn as a
    // chip is one the agent is told about. Not summarized at all for a message with no sigil.
    mentioned: (text) =>
      !text.includes("@")
        ? []
        : worktreeContext(text, [
            ...d.state.worktrees
              .filter((w) => w.repoId === wt.repoId && w.id !== wt.id && w.kind === "worktree")
              .map((w) => ({
                branch: w.branch,
                title: w.title,
                path: w.path,
                transcript: transcriptPathFor(d.paths.transcriptsDir, w.id),
              })),
            ...(d.archived?.(wt.repoId) ?? []).map((a) => ({
              branch: a.branch,
              title: a.title,
              path: a.path,
              transcript: a.transcript,
              archived: { at: a.archivedAt, landed: a.landed, restorable: a.restorable },
            })),
          ]),
    onProcess,
    spec,
    connect: (app, spec, prepared) => spawnAcp(app, d.agents.launch(spec, prepared), wt.path, wt.id),
    launch: (spec) => d.agents.command(spec),
    planSignIn: () => d.managed?.planSignIn ?? true,
    transcriptsDir: d.paths.transcriptsDir,
    attachments: d.attachments ?? new AttachmentStore(d.paths.attachmentsDir, new UploadStore(d.paths.uploadsDir)),
    getSessionId: () => d.state.session(wt.id),
    setSessionId: (id) => d.state.setSession(wt.id, id),
    onEvent: (event, seq) => d.hub.emit("agent", wt.id, seq, event),
    onStatus: (status) => d.hub.emit("agentStatus", wt.id, status),
    onStopping: () => d.hub.emit("agentStopping", wt.id),
    onHolding: () => d.hub.emit("agentHolding", wt.id),
    beforeTurn: async () => d.turnStarting?.(wt.id),
    onAuth: (agentId, o) => d.readiness?.observe(agentId, o),
    onLimits: (agentId, limits) => d.readiness?.observeLimits(agentId, limits),
    // read at call time, for the same reason as `spec`
    seedCommands: () => d.state.cachedCommands(d.state.requireWorktree(wt.id).agent ?? "", wt.repoId),
    onCommandsLearned: (commands) =>
      d.state.setCachedCommands(d.state.requireWorktree(wt.id).agent ?? "", wt.repoId, commands),
    // the spec at call time too: the folders depend on which agent this row runs
    commandOrigins: () => readCommandOrigins(commandFolders(spec(), wt.path)),
    // the record, read fresh: the composer changes it between turns and a plan approval sets it
    mode: () => d.state.requireWorktree(wt.id).mode ?? DEFAULT_PERMISSION_MODE,
    // the record only: the agent switched itself on the approval and reports it, so nothing is
    // pushed back at it (the service's setMode, the person's path, does push)
    setMode: (mode) => {
      if (d.state.setMode(wt.id, mode)) d.hub.emit("worktreesChanged");
    },
    // the handoff service is built after the runtime, so the hub is the seam, as it is for a landing
    onHandoff: (id, approved) => d.hub.emit("handoffDecided", wt.id, id, approved),
    onPlanUnsplit: (markdown, planPath) => d.hub.emit("planUnsplit", wt.id, markdown, planPath),
    // the briefs as a file for the card's section; the record's own plan stays the agent's plan
    onHandoffShown: (_id, pieces) => writePlanDocNow(wt.path, listDoc(pieces)),
    onPlan: async (markdown, ownFile) => {
      const w = d.state.worktree(wt.id);
      if (w && !w.planned) {
        w.planned = true;
        d.state.save();
      }
      // the agent's own file when it kept one in the worktree; else a copy is written for an agent
      // that sent its plan as a payload, and an agent that sent no prose has nothing to write,
      // its card is the whole plan
      const own = ownFile ? ownPlanPath(wt.path, ownFile) : null;
      const path = own ?? (markdown.trim() ? await writePlanDoc(wt.path, markdown) : null);
      // the record names the file so the composer can point at it after the card is gone; the
      // record is read fresh, since the card's await may span a change to it
      const fresh = path ? d.state.worktree(wt.id) : undefined;
      if (fresh && path && fresh.plan !== path) {
        fresh.plan = path;
        d.state.save();
        d.hub.emit("worktreesChanged");
      }
      return path;
    },
    planEdited: async (path, proposed) => planEdited(wt.path, path, proposed),
    option: (category) => d.state.requireWorktree(wt.id)[OPTION_FIELDS[category]],
    // kept per agent, not per worktree, by the worktree service: the picker on a worktree whose
    // session has not opened yet shows what this agent offered last time
    onOptionsLearned: (category, choices, runs) =>
      d.hub.emit("optionsLearned", d.state.requireWorktree(wt.id).agent ?? "", category, choices, runs),
    // the chat's choice becomes the record's, so the picker shows what runs and the next turn
    // keeps it rather than putting the picker's old value back
    onOptionChanged: (category, value) => {
      const w = d.state.requireWorktree(wt.id);
      const field = OPTION_FIELDS[category];
      if ((w[field] ?? "") === value) return;
      // empty is the agent's own choice: the field goes, as the empty option's set does
      if (value) w[field] = value;
      else delete w[field];
      d.state.save();
      d.hub.emit("worktreesChanged");
    },
    ...(mcp ? { mcp: { open: () => mcp.open(wt.id), close: () => mcp.close(wt.id) } } : {}),
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
    remote: () => d.remote?.() ?? null,
    gate: () => d.gate?.() ?? null,
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

/** where a proc answers once it does (at the port it actually bound when that differs from the
 * one it was given); null while it is starting or asleep, so a proxy or a forwarder waits for it
 * rather than dialing a port nothing is on yet */
function targetOf(st: ProcState | undefined): ForwardTarget | null {
  if (st?.status !== "running") return null;
  return { port: st.boundPort ?? st.port, host: st.host ?? "127.0.0.1" };
}

/** where the proxy forwards: the preview proc */
function previewTargetOf(procs: WorktreeProcs, previewName: string | undefined): ProxyTarget | null {
  return targetOf(previewProcOf(procs, previewName));
}

/** the forwarder port per proc that has one, for the URL variables; `except` is the proc being
 * started, which gets no address of its own */
function forwardPorts(forwards: ReadonlyMap<string, ProcForwarder>, except?: string): Map<string, number> {
  const ports = new Map<string, number>();
  for (const [name, f] of forwards) if (name !== except) ports.set(name, f.port);
  return ports;
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
  /** runtimes stop() has taken out of `runtimes` and is still killing: the ledger keeps their
   * groups until the kills are through, or a daemon dying mid-stop would have nothing to reclaim */
  private stopping = new Map<string, Runtime>();
  /** groups other services run on a worktree and ask the ledger to carry (noteGroup), by pgid */
  private extraGroups = new Map<string, Map<number, string>>();

  constructor(private deps: RuntimeDeps) {
    // a proc came up or went (a crash, a restart, a wake); an exit while asleep or stopped says
    // nothing here, and the sleep and stop paths record after their kills instead
    deps.hub.on("proc", (id) => this.recordGroups(id));
    // a front that addresses previews by port has each one declared to it, so they cannot be
    // ephemeral: the range is pinned before any proxy starts, and follows the name while running
    this.ports.setRange(this.rangeFor());
    deps.hub.on("remoteChanged", () => fireAndForget("remote", this.remoteChanged(), "move the previews"));
  }

  /** the fixed range the public name's front forwards, or null for none */
  private rangeFor(): { from: number; to: number } | null {
    const r = this.deps.remote?.() ?? null;
    return r && addressedByPort(r.previews) ? PREVIEW_PORTS : null;
  }

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

  /** A group of another service's (a `!` command's shell) goes in the worktree's ledger entry
   * beside the procs, so a daemon killed under it leaves something the next one reclaims. Live
   * only while `forgetGroup` has not been called for it; a rebuild from the procs keeps it. */
  noteGroup(id: string, name: string, pgid: number): void {
    let groups = this.extraGroups.get(id);
    if (!groups) {
      groups = new Map();
      this.extraGroups.set(id, groups);
    }
    groups.set(pgid, name);
    this.recordGroups(id);
  }

  forgetGroup(id: string, pgid: number): void {
    const groups = this.extraGroups.get(id);
    if (!groups?.delete(pgid)) return;
    if (groups.size === 0) this.extraGroups.delete(id);
    this.recordGroups(id);
  }

  /** Work someone is waiting on: an agent mid-turn or stopped on an error, a message of the
   * person's still owed a turn (queued, steered or refused), a command the agent sent to the
   * background or a wakeup it booked, or a turn or command holding the worktree. What idle sleep,
   * an automatic update and an archive of a worktree's own accord all leave alone. A card open for
   * a person is not work: the shell brings an expired card back and the answer goes as a message,
   * so a waiting row is as free to sleep, stop or archive as an idle one. */
  busy(id: string): boolean {
    const agent = this.agentFor(id);
    if (agent && ((agent.status !== "idle" && agent.status !== "waiting") || agent.unsettled || agent.holding > 0))
      return true;
    return this.holdCount(id) > 0;
  }

  /** the card nobody answered closes and the agent's process goes; nothing happens to a row that
   * carries no card, so the idle clock calls this on every row it puts to sleep */
  async lapse(id: string, why: string): Promise<void> {
    const agent = this.agentFor(id);
    if (agent?.status === "waiting") await agent.lapse(why);
  }

  /** whether any worktree is busy */
  anyBusy(): boolean {
    for (const id of this.runtimes.keys()) if (this.busy(id)) return true;
    for (const id of this.holds.keys()) if (this.busy(id)) return true;
    return false;
  }

  /** What the machine itself is needed for: something running on its own (a turn, a command), a
   * card that only a person can move, or nothing. Narrower than `busy`: an agent in error or one
   * with a message still queued is owed something, but nothing is running that sleep would stop.
   * An idle agent with a command in the background or a wakeup booked is working: the command runs
   * under its process, and the wakeup is a turn the machine has to be up for. */
  demand(): "working" | "waiting" | null {
    if (this.holds.size > 0) return "working";
    let waiting = false;
    for (const rt of this.runtimes.values()) {
      if (rt.agent.status === "working" || rt.agent.holding > 0) return "working";
      if (rt.agent.status === "waiting") waiting = true;
    }
    return waiting ? "waiting" : null;
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
    // a spare comes up at the end of its own warm-up, never from a look at it: the plus is on
    // screen the whole time, and before the warm-up marks it there is no directory to run in
    if (wt.kind === "spare" && wt.phase !== undefined && wt.phase !== "ready") return;
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
    this.recordGroups(id);
    this.deps.hub.emit("worktreesChanged");
  }

  private get ports(): PortLease {
    return this.deps.ports ?? proxyPorts;
  }

  /** The public name changed while copies run. A front forwards a fixed few ports, so every
   * running proxy moves onto one of them: stopped, its port returned, started again on a leased
   * one. The dev servers behind the proxies are not touched; the rows frame carries each new port
   * to the shell, whose frame loads it. A copy for which no port is left sleeps, as a start with
   * none would. With the name gone the range goes and running proxies keep their ports; the new
   * name and gate reach a proxy through its getters either way. */
  async remoteChanged(): Promise<void> {
    this.ports.setRange(this.rangeFor());
    if (!this.ports.ranged()) {
      for (const id of [...this.leased.keys()]) this.returnLease(id);
      return;
    }
    for (const [id, rt] of this.runtimes) {
      if (!rt.proxy) continue;
      const live = this.deps.state.worktree(id);
      if (!live) continue;
      rt.proxy.stop();
      rt.proxy = null;
      this.returnLease(id);
      const port = this.ports.lease(live.proxyPort);
      if (port === null) {
        await this.sleep(id, `no preview port in ${this.ports.label()} was free for it`);
        continue;
      }
      this.leased.set(id, port);
      this.openProxy(rt, live, port);
    }
    this.deps.hub.emit("worktreesChanged");
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
          (code) => {
            this.deps.hub.emit("termExit", id, SHELL_STREAM, code);
            this.recordGroups(id);
          },
        );
      } catch (e) {
        throw new UserError(`could not start a shell: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.looseShells.set(id, term);
      this.recordGroups(id);
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
      this.recordGroups(id);
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
      agent: (this.deps.makeAgent ?? defaultAgent)(
        wt,
        this.deps,
        () => this.previewStanding(wt.id),
        () => this.recordGroups(wt.id),
      ),
      procs: null,
      proxy: null,
      previewName: undefined,
      cfg: null,
      run: null,
      configWatch: null,
      forwards: new Map(),
      shared: new Set(),
      borrowed: new Set(),
      pointed: new Map(),
      remoteBehind: new Set(),
      shell: null,
      login: null,
    };
    this.runtimes.set(wt.id, rt);
    return rt;
  }

  /** Start the worktree's procs and proxy under its settings (its own file, else the repo's),
   * narrowed by the worktree's profile; no-op if already running. Main is two tiers: the shared one (`from: "trunk"`) it
   * runs whatever stands in for it, once for every worktree of the repo, and its page and proxy
   * only as the lead (setup unconfirmed, an empty project, a warm-up that failed), which keeps the
   * setup pane and the first-run preview working. A main that ran the shared tier alone and leads
   * now gets its page. A worktree runs everything but what it borrows. */
  async start(wt: WorktreeInfo, repo: RepoInfo): Promise<void> {
    const record = this.deps.state.worktree(wt.id);
    if (!record) return; // removed while setup was running
    const rt = this.ensureAgent(wt);
    // parked: every edge that wakes a worktree ends here, and none of them is someone asking for
    // this one's preview
    if (record.parked) return;
    // unconfirmed detection: no procs until the user confirms the setup pane
    const cfg = configFor(wt, repo);
    const run = repo.needsSetup ? EMPTY_RUN : resolveRun(cfg, wt, repo.tier ?? {});
    const leads = wt.kind !== "main" || !this.deps.mainLeads || this.deps.mainLeads(wt.repoId);
    if (rt.procs) {
      if (leads && wt.kind === "main" && !rt.proxy) await this.startPage(rt, wt, repo, run);
      return;
    }
    if (!leads && run.shared.length === 0) return;
    // setup's own start says nothing: the setup runner said it, where the setup lines are
    if (!this.settingUp.has(wt.id))
      for (const line of settingsLines(cfg, repo)) this.deps.hub.emit("log", wt.id, "setup", line);

    // before anything starts, so running out of preview ports leaves nothing half up. The record
    // keeps the port it got, and the rows frame sent once the proxy is up carries it to the shell
    const live = this.deps.state.requireWorktree(wt.id);
    let port: number | null = null;
    if (leads) {
      port = this.leasePort(live);
      if (port === null) return;
    }

    const procs = (this.deps.makeProcs ?? defaultProcs)(wt, this.deps);
    rt.procs = procs;
    rt.cfg = cfg;
    rt.run = run;
    rt.previewName = leads ? run.preview : undefined;
    rt.shared = new Set(run.shared);
    rt.borrowed = new Set(run.borrowed);
    rt.pointed = new Map(Object.entries(run.pointed));
    rt.remoteBehind.clear();
    const spawn = leads ? spawnsOf(run) : run.shared;
    await this.bringUp(rt, wt, repo, run, spawn);

    if (!this.deps.state.worktree(wt.id) || this.runtimes.get(wt.id) !== rt) {
      // removed while the procs were starting: don't leave them running
      this.returnLease(wt.id);
      this.stopForwards(rt);
      await procs.stopAll();
      return;
    }
    if (port !== null) this.openProxy(rt, live, port);
    this.deps.hub.emit("worktreesChanged");
    // armed once the start is whole, since a stop under a start in flight would leave it opening
    // a proxy on procs that are gone; a write during the spawns is caught by the look that follows
    if (wt.kind !== "main") {
      rt.configWatch = this.watchConfig(rt, wt);
      this.settingsChanged(rt, wt.id);
    }
  }

  /** whether the worktree's procs would come up differently now: its settings or the trunk moved
   * under it. False while nothing runs. What the repo's reload asks before restarting a row. */
  runChanged(wt: WorktreeInfo, repo: RepoInfo): boolean {
    const now = this.runOf(wt.id);
    if (!now) return false;
    const next = repo.needsSetup ? EMPTY_RUN : resolveRun(configFor(wt, repo), wt, repo.tier ?? {});
    return JSON.stringify(next) !== JSON.stringify(now);
  }

  /** main's page beside the shared tier it already runs: the spare that stood in for it is gone */
  private async startPage(rt: Runtime, wt: WorktreeInfo, repo: RepoInfo, run: ResolvedRun): Promise<void> {
    const procs = rt.procs!;
    const live = this.deps.state.requireWorktree(wt.id);
    const port = this.leasePort(live);
    if (port === null) return;
    rt.previewName = run.preview;
    const up = new Set(procs.states().map((p) => p.name));
    await this.bringUp(
      rt,
      wt,
      repo,
      run,
      spawnsOf(run).filter((n) => !up.has(n)),
    );
    if (this.runtimes.get(wt.id) !== rt) return;
    this.openProxy(rt, live, port);
    this.deps.hub.emit("worktreesChanged");
  }

  /** The worktree's own settings file, while its procs run: a checkout, a rebase or an edit that
   * changes it brings the procs back under the new one, the way the repo's watcher does for
   * main's. A write that leaves the config as it was (a touch, a checkout that kept the file)
   * changes nothing, and a file that will not read keeps the procs as they are, since it is
   * mid-edit more often than not. An asleep worktree only goes cold, so idle sleep is not undone:
   * the next look starts it under the new file. */
  private watchConfig(rt: Runtime, { id, path }: WorktreeInfo): (() => void) | null {
    if (!existsSync(path)) return null;
    return watchConfigFile(path, () => this.settingsChanged(rt, id));
  }

  /** the look at the worktree's file the watcher takes, and the start takes once for the spawns */
  private settingsChanged(rt: Runtime, id: string): void {
    if (this.runtimes.get(id) !== rt || !rt.procs || !rt.cfg || this.starting.has(id)) return;
    const wt = this.deps.state.worktree(id);
    const repo = wt && this.deps.state.repos.find((r) => r.id === wt.repoId);
    if (!wt || !repo) return;
    const next = configFor(wt, repo);
    if (next.reason) {
      this.deps.hub.emit("log", id, "setup", `${next.reason}; keeping the procs as they are`);
      return;
    }
    if (JSON.stringify(next.config) === JSON.stringify(rt.cfg.config)) return;
    log.info(id, `${next.file} changed: restarting`);
    const restart = rt.procs.asleep ? this.stopProcs(id) : this.stopProcs(id).then(() => this.wake(id));
    fireAndForget(id, restart, "settings restart");
  }

  /** Spawn `spawn` of the run's procs, the preview last, with a forwarder in front of every
   * non-preview proc the worktree runs or borrows, bound before anything spawns, so every proc's
   * env names its siblings at addresses that hold for the worktree's life: a proc that restarts on
   * another port, or sleeps and wakes, or runs on main until this worktree takes it over, is
   * reached at the same place, and nothing has to respawn for it. */
  private async bringUp(
    rt: Runtime,
    wt: WorktreeInfo,
    repo: RepoInfo,
    run: ResolvedRun,
    spawn: string[],
  ): Promise<void> {
    const procs = rt.procs!;
    const previewName = rt.previewName;
    for (const name of [...spawn, ...rt.borrowed]) {
      if (name !== previewName && !rt.forwards.has(name)) rt.forwards.set(name, this.openForward(wt, procs, name));
    }
    this.starting.add(wt.id);
    try {
      for (const name of spawn) {
        if (name !== previewName) await procs.start(name, run.procs[name]!, this.envFor(rt, wt, repo, name));
      }
      if (previewName && spawn.includes(previewName)) {
        await procs.start(previewName, run.procs[previewName]!, this.envFor(rt, wt, repo, previewName));
      }
    } finally {
      this.starting.delete(wt.id);
    }
  }

  /** Every proc gets its siblings' addresses, the forwarder's for one that has one and the remote
   * URL for one the page points away, and the proc itself gets no address of its own. The
   * worktree's own variables ride along. */
  private envFor(rt: Runtime, wt: WorktreeInfo, repo: RepoInfo, name: string): Record<string, string> {
    return {
      ...procUrlEnv(rt.procs?.states() ?? [], rt.previewName, forwardPorts(rt.forwards, name), rt.pointed),
      ...worktreeEnv(wt, repo),
    };
  }

  /** the id of the repo's main checkout, whose shared tier a worktree borrows */
  private mainIdOf(repoId: string): string | undefined {
    return this.deps.state.worktrees.find((w) => w.repoId === repoId && w.kind === "main")?.id;
  }

  /** whether the worktree reaches any of the shared tier on main rather than running it */
  borrows(id: string): boolean {
    return (this.runtimes.get(id)?.borrowed.size ?? 0) > 0;
  }

  /** the run the worktree's procs came up under, with what it borrows as it stands now (a
   * take-over shrinks it); undefined while nothing runs */
  runOf(id: string): ResolvedRun | undefined {
    const rt = this.runtimes.get(id);
    return rt?.run ? { ...rt.run, borrowed: [...rt.borrowed] } : undefined;
  }

  /** whether the worktree's page points any proc at a remote */
  points(id: string): boolean {
    return (this.runtimes.get(id)?.pointed.size ?? 0) > 0;
  }

  /** whether the worktree has a live proc of that name, pending or spawned */
  runs(id: string, name: string): boolean {
    return (
      this.runtimes
        .get(id)
        ?.procs?.states()
        .some((p) => p.name === name) ?? false
    );
  }

  /** the pointed procs whose files the worktree has changed since: what the chip warns about */
  remoteBehind(id: string): string[] {
    return [...(this.runtimes.get(id)?.remoteBehind ?? [])];
  }

  /** the flip's reading of the pointed procs, replacing the last; a row fact, so a change is a frame */
  markRemoteBehind(id: string, names: string[]): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const next = new Set(names.filter((n) => rt.pointed.has(n)));
    if (next.size === rt.remoteBehind.size && [...next].every((n) => rt.remoteBehind.has(n))) return;
    rt.remoteBehind = next;
    this.deps.hub.emit("worktreesChanged");
  }

  /** what the worktree borrows, each with main's state of it: "cold" while main has not started
   * its tier, so a copy's row can say that main's api is down rather than hide the proc */
  borrowedStates(id: string): Borrowed[] {
    const rt = this.runtimes.get(id);
    if (!rt || rt.borrowed.size === 0) return [];
    const mainId = this.mainIdOf(rt.info.repoId);
    const states = mainId ? (this.runtimes.get(mainId)?.procs?.states() ?? []) : [];
    return [...rt.borrowed].map((name) => {
      const st = states.find((p) => p.name === name);
      return st ? { name, status: st.status, ...(st.detail ? { detail: st.detail } : {}) } : { name, status: "cold" };
    });
  }

  /** The named borrowed proc is about to be set up here before it runs: it takes its place among
   * the worktree's procs as `starting` with `detail` saying which setup step, so its tab, the row
   * and the chip can say why it is not up, while its forwarder keeps reaching main's until `own()`
   * spawns into the place this made. A second call on the same name only moves the detail. */
  preparing(id: string, name: string, command: string, detail: string): void {
    const rt = this.runtimes.get(id);
    if (!rt?.procs) return;
    rt.procs.pending(name, command, detail);
    this.deps.hub.emit("worktreesChanged");
  }

  /** a setup step's output for a pending proc: its tab and the log ring */
  setupOutput(id: string, name: string, data: string): void {
    this.runtimes.get(id)?.procs?.setupOutput(name, data);
  }

  /** the pending place goes: the setup failed and the proc stays main's */
  async unprepare(id: string, name: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt?.procs) return;
    await rt.procs.drop(name);
    this.deps.hub.emit("worktreesChanged");
  }

  /** The forwarder in front of one proc: it dials the proc where it answers, waits while the proc
   * is starting or the worktree is waking, and a connection while asleep is the wake. A borrowed
   * proc is main's until the worktree runs one of its own, from which moment only its own counts,
   * so a crash of its own reads as a crash and never as main's page. */
  private openForward(wt: WorktreeInfo, procs: WorktreeProcs, name: string): ProcForwarder {
    // a place held for the proc while its setup runs is not its own yet: main's keeps answering
    const own = () => (procs.isPending(name) ? undefined : procs.states().find((p) => p.name === name));
    const trunk = () => {
      if (!this.runtimes.get(wt.id)?.borrowed.has(name)) return undefined;
      const mainId = this.mainIdOf(wt.repoId);
      return mainId
        ? this.runtimes
            .get(mainId)
            ?.procs?.states()
            .find((p) => p.name === name)
        : undefined;
    };
    const waiting = (st: ProcState | undefined) => st?.status === "starting" || st?.status === "asleep";
    return (this.deps.makeForward ?? startForward)({
      port: 0,
      target: () => {
        const o = own();
        return o ? targetOf(o) : targetOf(trunk());
      },
      coming: () => {
        const o = own();
        if (o) return waiting(o);
        if (this.starting.has(wt.id)) return true;
        if (!this.runtimes.get(wt.id)?.borrowed.has(name)) return false;
        const t = trunk();
        if (t) return waiting(t);
        // main cold, or coming up: its shared tier is on its way once it is woken
        const mainId = this.mainIdOf(wt.repoId);
        return mainId !== undefined && !this.runtimes.get(mainId)?.procs?.states().length;
      },
      onConnect: () => {
        this.deps.hub.emit("forwardConnect", wt.id, name);
        fireAndForget(wt.id, this.wake(wt.id), "wake on connect");
        if (!own() && this.runtimes.get(wt.id)?.borrowed.has(name)) {
          const mainId = this.mainIdOf(wt.repoId);
          if (mainId) fireAndForget(mainId, this.wake(mainId), "wake the trunk for a borrower");
        }
      },
    });
  }

  private stopForwards(rt: Runtime) {
    for (const f of rt.forwards.values()) f.stop();
    rt.forwards.clear();
  }

  /** Main's page and proxy go and its shared tier stays: the spare is the trunk's running page
   * from here, and what it and every worktree borrow is what main keeps running. With nothing
   * shared, main is left as if never started. */
  async stopPage(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt?.procs) return;
    rt.proxy?.stop();
    rt.proxy = null;
    this.returnLease(id);
    rt.previewName = undefined;
    for (const st of rt.procs.states()) {
      if (rt.shared.has(st.name)) continue;
      rt.forwards.get(st.name)?.stop();
      rt.forwards.delete(st.name);
      await rt.procs.drop(st.name);
    }
    if (rt.procs.states().length === 0) {
      this.stopForwards(rt);
      await rt.procs.stopAll();
      rt.procs = null;
    }
    this.deps.hub.emit("worktreesChanged");
  }

  /** the named proc once it answers on its port, or null when nothing is coming */
  async awaitProc(id: string, name: string, ms: number): Promise<ForwardTarget | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const st = this.runtimes
        .get(id)
        ?.procs?.states()
        .find((p) => p.name === name);
      if (st?.status === "running") return targetOf(st);
      if (st?.status !== "starting" || Date.now() >= deadline) return null;
      await Bun.sleep(PREVIEW_POLL_MS);
    }
  }

  /** The worktree runs the named shared procs itself from here: each starts beside its siblings
   * with the env a first start gives, and its forwarder turns to it once it answers, cutting the
   * pairs on main's so the page reconnects. `owns` on the record is the caller's to persist first,
   * so a crashed flip recovers through the post-turn restart every proc has. */
  async own(id: string, names: string[]): Promise<void> {
    const rt = this.runtimes.get(id);
    const wt = this.deps.state.worktree(id);
    if (!rt?.procs || !rt.run || !wt) return;
    const run = rt.run;
    const started: string[] = [];
    for (const name of names) {
      if (!rt.borrowed.has(name) || !run.procs[name]) continue;
      rt.borrowed.delete(name);
      rt.remoteBehind.delete(name);
      await rt.procs.start(name, run.procs[name]!, this.envFor(rt, wt, this.deps.state.requireRepo(wt.repoId), name));
      started.push(name);
    }
    if (started.length === 0) return;
    log.info(id, `owns ${started.join(", ")}`);
    this.deps.hub.emit("worktreesChanged");
    for (const name of started) {
      await this.awaitProc(id, name, PROC_UP_MS);
      rt.forwards.get(name)?.retarget();
    }
  }

  /** the shared procs the worktree ran itself go, and main's are reached again */
  async share(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    const wt = this.deps.state.worktree(id);
    if (!rt?.procs || !rt.run || !wt) return;
    const run = rt.run;
    for (const name of run.borrowed) {
      if (rt.borrowed.has(name)) continue;
      rt.borrowed.add(name);
      await rt.procs.drop(name);
      rt.forwards.get(name)?.retarget();
    }
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
    rt.cfg = null;
    rt.run = null;
    rt.configWatch?.();
    rt.configWatch = null;
    rt.pointed.clear();
    rt.remoteBehind.clear();
    proxy?.stop();
    this.stopForwards(rt);
    this.returnLease(id);
    await procs?.stopAll();
    this.recordGroups(id);
  }

  /** stop everything for a worktree and forget it */
  async stop(id: string): Promise<void> {
    this.holds.delete(id);
    this.settingUp.delete(id);
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.runtimes.delete(id);
    this.stopping.set(id, rt);
    rt.configWatch?.();
    rt.configWatch = null;
    rt.proxy?.stop();
    this.stopForwards(rt);
    this.returnLease(id);
    const login = rt.login;
    rt.login = null;
    try {
      await Promise.all([rt.agent.close(), rt.procs?.stopAll(), rt.shell?.kill(), login?.pty.kill()]);
    } finally {
      if (this.stopping.get(id) === rt) this.stopping.delete(id);
      this.recordGroups(id);
    }
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
      // PWD keeps zsh/bash on the path as toyon spells it rather than a resolved one
      const cwd = wt.path;
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
          (code) => {
            this.deps.hub.emit("termExit", wt.id, SHELL_STREAM, code);
            this.recordGroups(wt.id);
          },
        );
      } catch (e) {
        throw new UserError(`could not start a shell: ${e instanceof Error ? e.message : String(e)}`);
      }
      rt.shell = term;
      this.recordGroups(wt.id);
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
    const cwd = wt.path;
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
          this.recordGroups(id);
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
    this.recordGroups(id);
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
    // a proc being set up before its spawn has no pty yet: its tab starts from what the setup has
    // printed and is not drawn as exited
    const prelude = procs?.prelude(stream);
    if (prelude !== undefined) return { snapshot: prelude, alive: true };
    // a tab can open before its proc has spawned (mid-restart): an empty snapshot is right, and the
    // tab fills in when the proc starts streaming
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
    return terminalEnv(
      process.env,
      worktreeEnv(wt, repo),
      procUrlEnv(rt?.procs?.states() ?? [], rt?.previewName, forwardPorts(rt?.forwards ?? new Map()), rt?.pointed),
    );
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
    const wt = this.deps.state.worktree(id);
    if (wt?.parked) {
      const repo = this.deps.state.repos.find((r) => r.id === wt.repoId);
      return repo && !repo.needsSetup && resolveRun(configFor(wt, repo), wt, repo.tier ?? {}).preview
        ? { status: "parked" }
        : null;
    }
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

  /** The ledger entry for a worktree, rebuilt from what is live: each proc's pty, the adapter,
   * the shell, the login, or a found worktree's loose shell. Live ptys only, never `ProcState.pid`,
   * which a crash leaves set. An entry keeps its first `startedAt` across rebuilds; the reclaim
   * matches a leader's start against it. A group whose handle has gone while something in it still
   * answers stays on the books: this daemon has nothing left to kill it with, and the next one
   * reads the ledger. */
  private recordGroups(id: string) {
    const rt = this.runtimes.get(id) ?? this.stopping.get(id);
    const live: Array<{ name: string; pgid: number }> = [];
    if (rt) {
      for (const g of rt.procs?.groups() ?? []) live.push(g);
      if (rt.agent.pgid !== null) {
        const agentId = this.deps.state.worktree(id)?.agent ?? this.deps.agents.defaultId(this.deps.state.defaultAgent);
        live.push({ name: `agent:${agentId}`, pgid: rt.agent.pgid });
      }
      if (rt.shell?.alive) live.push({ name: "shell", pgid: rt.shell.pid });
      if (rt.login?.pty.alive) live.push({ name: "login", pgid: rt.login.pty.pid });
    }
    const loose = this.looseShells.get(id);
    if (loose?.alive) live.push({ name: "shell", pgid: loose.pid });
    for (const [pgid, name] of this.extraGroups.get(id) ?? []) live.push({ name, pgid });
    const before = new Map(this.deps.state.groups(id).map((g) => [g.pgid, g]));
    const now = Date.now();
    const next: GroupEntry[] = live.map((g) => ({ ...g, startedAt: before.get(g.pgid)?.startedAt ?? now }));
    const alive = this.deps.groupAlive ?? groupAlive;
    for (const [pgid, g] of before) {
      if (!live.some((l) => l.pgid === pgid) && alive(pgid)) next.push(g);
    }
    this.deps.state.setGroups(id, next);
  }

  /** Kill what the last daemon left running: the groups its ledger names that are still up with
   * no daemon over them, any adapter reparented to init, and anything reparented to init that runs
   * from a worktree directory no record names (the ledger can lose a group to a crash before its
   * write, or to a daemon from before it was kept). Before anything is spawned, so the memory and
   * the ports come back before the first wake takes them. Then the ledger starts over under this
   * boot. */
  async reclaimOrphans(): Promise<void> {
    const machine = this.deps.machine ?? { bootId, psGroups };
    const [boot, rows] = await Promise.all([machine.bootId(), machine.psGroups()]);
    const state = this.deps.state;
    const found: Orphan[] = orphansIn(state.allGroups(), rows, boot, state.bootAt, Date.now());
    const seen = new Set(found.map((o) => o.pgid));
    for (const row of strayAdapters(rows, this.deps.paths.agentsDir)) {
      if (seen.has(row.pgid)) continue;
      seen.add(row.pgid);
      found.push({ worktreeId: "daemon", pgid: row.pgid, name: "adapter" });
    }
    const livePaths = new Set(state.worktrees.map((w) => w.path));
    for (const o of strayProcs(rows, this.deps.paths.worktreesDir, livePaths)) {
      if (seen.has(o.pgid)) continue;
      seen.add(o.pgid);
      found.push(o);
    }
    const reclaim = this.deps.reclaim ?? reclaimGroup;
    await Promise.all(
      found.map(async (o) => {
        await reclaim(o.pgid);
        log.info(o.worktreeId, `reclaimed ${o.name} group ${o.pgid} left by the last daemon`);
      }),
    );
    state.clearGroups();
    state.setBootAt(boot);
  }

  async shutdown(): Promise<void> {
    this.pruneLooseShells(new Set());
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
  }
}
