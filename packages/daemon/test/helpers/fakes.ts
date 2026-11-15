import type {
  AgentCommand,
  AgentEvent,
  AgentStatus,
  LogLine,
  ProcState,
  QueuedMessage,
  StoppedBy,
  WorktreeInfo,
} from "@toyon/shared";
import { isBusy } from "@toyon/shared";
import type { AgentAdapter, AskOpts, AskReply, FollowUp, SendOpts } from "../../src/agent/adapter.ts";
import { isNews, newsToSend } from "../../src/agent/news.ts";
import { AgentReadiness, type AgentReadinessDeps } from "../../src/agent/readiness.ts";
import { AgentRegistry, type AgentSpec } from "../../src/agent/registry.ts";
import type { ForwardOpts, ProcForwarder } from "../../src/runtime/forward.ts";
import type { PreviewHandler, WorktreeProxy } from "../../src/runtime/proxy.ts";
import type { PtyHandle, PtyOpts } from "../../src/runtime/pty.ts";
import type { RuntimeDeps } from "../../src/runtime/registry.ts";
import type { WorktreeProcs } from "../../src/runtime/supervisor.ts";

export class FakeAgent implements AgentAdapter {
  private status_: AgentStatus = "idle";
  get status(): AgentStatus {
    return this.status_;
  }
  /** a test moves the status by hand; coming to rest is when untold news goes, as in the session */
  set status(s: AgentStatus) {
    this.status_ = s;
    this.pumpNews();
  }
  /** the session's `atRest`: a world with a handoff service points it there */
  atRest: () => boolean = () => false;
  /** how far the transcript was told. The session records each message it sends on the
   * transcript; a fake's `send` records nothing, so the mark stands in for the message. */
  private told = 0;
  /** The session's rule for news, on the same reading of the transcript (agent/news.ts): Toyon's
   * message for what the agent has not been told, once it is at rest. What the session adds, the
   * queue and the cards, has its own tests. */
  private pumpNews() {
    if (isBusy(this.status_) || this.held) return;
    const news = newsToSend(this.transcript(), { from: this.told, rest: this.atRest() });
    if (!news) return;
    const asked = {
      kind: "news" as const,
      why: news.why,
      ...(news.from ? { from: news.from } : {}),
      ...(news.toolId ? { toolId: news.toolId } : {}),
    };
    this.send(news.text, { asked, keepCards: true });
    // Toyon's own message is on the transcript as it goes, as the session records it: what reads
    // the transcript for whether the agent was told (a failure's report) finds it there
    this.recorded.push({ type: "fix-asked", text: news.text, ts: Date.now(), ...asked });
    this.told = this.recorded.length;
  }
  /** how many times the chat was opened */
  opens = 0;
  opened() {
    this.opens++;
    this.pumpNews();
  }
  holding = 0;
  wakes: number | null = null;
  sent: Array<{ text: string } & SendOpts> = [];
  stops = 0;
  onQueueChange: (() => void) | null = null;
  commands: AgentCommand[] = [];
  onCommandsChange: ((commands: AgentCommand[]) => void) | null = null;
  warms = 0;
  /** the agent whose process is up; the warm-up counts as spawning the registry's default */
  runningAgent: string | null = null;
  /** what a test says the agent took at session start; a warm-up settles a null to `warmedTools` */
  mcpTools: boolean | null = null;
  warmedTools: boolean | null = true;
  async warmCommands() {
    await this.warm();
  }
  async warm() {
    this.warms++;
    this.runningAgent ??= "claude";
    this.mcpTools ??= this.warmedTools;
  }
  restarts = 0;
  async restart() {
    this.restarts++;
    this.runningAgent = null;
  }
  lapses: string[] = [];
  async lapse(why: string) {
    this.lapses.push(why);
    this.status = "idle";
    this.runningAgent = null;
  }
  modeChanges = 0;
  modeChanged() {
    this.modeChanges++;
  }
  pgid: number | null = null;
  /** the registry's ear for the process group, wired by the factory */
  onProcess: (() => void) | null = null;
  /** play the adapter process coming up (a pgid) or going (null) */
  setProcess(pgid: number | null) {
    this.pgid = pgid;
    this.onProcess?.();
  }
  constructor(readonly worktreeId: string) {}
  get queueLength() {
    return 0;
  }
  /** messages a test leaves waiting, for `unqueue` to take */
  queued: QueuedMessage[] = [];
  get queueItems(): QueuedMessage[] {
    return this.queued;
  }
  unsettled = false;
  send(text: string, opts: SendOpts = {}) {
    this.sent.push({ text, ...opts });
    this.told = this.recorded.length;
  }
  /** whether the queue is held now, and how many times it was */
  held = false;
  holds = 0;
  /** the holds not yet released: the queue is held while any is */
  private open = 0;
  hold() {
    this.held = true;
    this.holds++;
    this.open++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.open--;
      this.held = this.open > 0;
      // the queue let go is a moment untold news goes, as in the session
      this.pumpNews();
    };
  }
  /** who asked for each stop another chat's agent asked for */
  stoppedBy: StoppedBy[] = [];
  stop(by?: StoppedBy) {
    this.stops++;
    if (by) this.stoppedBy.push(by);
    return isBusy(this.status);
  }
  closes = 0;
  async close() {
    this.closes++;
  }
  asked: Array<[string, string, AskOpts | undefined]> = [];
  askReply: string | null = null;
  async ask(system: string, prompt: string, opts?: AskOpts) {
    this.asked.push([system, prompt, opts]);
    return this.askReply;
  }
  answered: Array<[string, AskReply, FollowUp | undefined]> = [];
  answer(askId: string, reply: AskReply, followUp?: FollowUp) {
    this.answered.push([askId, reply, followUp]);
  }
  auths: Array<[string, string | undefined]> = [];
  async authenticate(methodId: string, apiKey?: string) {
    this.auths.push([methodId, apiKey]);
    return methodId === "terminal"
      ? { kind: "terminal" as const, run: { command: "/bin/login", args: ["--now"], env: { NO_BROWSER: "1" } } }
      : { kind: "done" as const };
  }
  retries = 0;
  retry() {
    this.retries++;
  }
  logins = 0;
  loggedIn() {
    this.logins++;
  }
  unqueue(index: number, taken?: (message: QueuedMessage) => void) {
    const [message] = this.queued.splice(index, 1);
    if (message) taken?.(message);
  }
  /** what the daemon put on the transcript itself (exec results); an agent's own events never
   * reach a fake */
  recorded: AgentEvent[] = [];
  note(event: AgentEvent) {
    this.recorded.push(event);
    if (isNews(event)) this.pumpNews();
  }
  transcript(): Array<{ seq: number; event: AgentEvent }> {
    return this.recorded.map((event, seq) => ({ seq, event }));
  }
}

/** records starts/stops; never spawns */
export class FakeProcs {
  started: Array<{ name: string; command: string; env: Record<string, string> }> = [];
  stopped = false;
  private states_: ProcState[] = [];
  async start(name: string, command: string, env: Record<string, string> = {}): Promise<ProcState> {
    this.started.push({ name, command, env });
    // a preparing place of that name is spawned into, the way the supervisor keeps its port and tab
    const held = this.states_.find((s) => s.name === name && s.status === "preparing");
    if (held) {
      held.command = command;
      held.status = "running";
      held.host = "127.0.0.1";
      held.detail = undefined;
      return held;
    }
    const st: ProcState = { name, command, port: 40000 + this.started.length, status: "running", host: "127.0.0.1" };
    this.states_.push(st);
    return st;
  }
  /** the places held before a spawn, in order, with every detail they were given */
  pendings: Array<{ name: string; command: string; detail: string }> = [];
  async pending(name: string, command: string, detail: string): Promise<ProcState> {
    this.pendings.push({ name, command, detail });
    const had = this.states_.find((s) => s.name === name && s.status === "preparing");
    if (had) {
      had.detail = detail;
      return had;
    }
    const st: ProcState = {
      name,
      command,
      port: 40000 + this.started.length + this.pendings.length,
      status: "preparing",
      detail,
    };
    this.states_.push(st);
    return st;
  }
  /** setup output per pending proc, as given */
  outputs: Array<[string, string]> = [];
  setupOutput(name: string, data: string) {
    this.outputs.push([name, data]);
  }
  prelude(name: string): string | undefined {
    if (!this.states_.some((s) => s.name === name && s.status === "preparing")) return undefined;
    return this.outputs
      .filter(([n]) => n === name)
      .map(([, d]) => d)
      .join("");
  }
  async stopAll() {
    this.stopped = true;
    for (const s of this.states_) s.status = "stopped";
  }
  asleep = false;
  async sleep(why: string) {
    this.asleep = true;
    for (const s of this.states_) {
      s.status = "asleep";
      s.detail = why;
    }
  }
  wake() {
    this.asleep = false;
    for (const s of this.states_) {
      s.status = "running";
      s.detail = undefined;
    }
  }
  /** the live fakes by name, the way the supervisor reports its ptys */
  groups(): Array<{ name: string; pgid: number }> {
    return [...this.ptys].filter(([, t]) => t.alive).map(([name, t]) => ({ name, pgid: t.pid }));
  }
  pgids(): number[] {
    return this.groups().map((g) => g.pgid);
  }
  restarts: string[] = [];
  restart(name: string) {
    this.restarts.push(name);
  }
  stops: string[] = [];
  async stop(name: string) {
    this.stops.push(name);
    const s = this.states_.find((p) => p.name === name);
    if (s) s.status = "stopped";
  }
  dropped: string[] = [];
  async drop(name: string) {
    this.dropped.push(name);
    this.states_ = this.states_.filter((p) => p.name !== name);
  }
  recentLogs(): LogLine[] {
    return [];
  }
  states(): ProcState[] {
    return this.states_.map((s) => ({ ...s }));
  }
  /** the pty side of a proc, so a tab can attach to it in tests */
  ptys = new Map<string, FakeTerminal>();
  writes: Array<[string, string]> = [];
  resizes: Array<[string, number, number]> = [];
  stream(name: string): FakeTerminal | undefined {
    return this.ptys.get(name);
  }
  write(name: string, data: string) {
    this.writes.push([name, data]);
    this.ptys.get(name)?.write(data);
  }
  resize(name: string, cols: number, rows: number) {
    this.resizes.push([name, cols, rows]);
    this.ptys.get(name)?.resize(cols, rows);
  }
  /** stand up a proc's pty; `emit` and `exit` on the returned handle play its side */
  spawnFake(name: string): FakeTerminal {
    const t = new FakeTerminal(
      { cwd: "/", env: {}, cols: 120, rows: 30, file: "sh" },
      () => {},
      () => {},
    );
    this.ptys.set(name, t);
    return t;
  }
}

/** a forwarder that binds nothing: its port counts up from 50000, and it remembers what it was
 * told, so a test can read where a connection would go and play one arriving */
export class FakeForwarder implements ProcForwarder {
  static next = 50000;
  readonly port = FakeForwarder.next++;
  stopped = false;
  retargets = 0;
  constructor(readonly opts: ForwardOpts) {}
  target() {
    return this.opts.target();
  }
  coming() {
    return this.opts.coming();
  }
  connect() {
    this.opts.onConnect?.();
  }
  retarget() {
    this.retargets++;
  }
  stop() {
    this.stopped = true;
  }
}

export class FakeProxy implements WorktreeProxy {
  stopped = false;
  handler: PreviewHandler = {
    fetch: async () => new Response("fake preview"),
    open: () => {},
    message: () => {},
    close: () => {},
  };
  constructor(readonly port: number) {}
  stop() {
    this.stopped = true;
  }
  setTarget() {}
}

let nextFakePid = 4242;

/** records writes/resizes/kills; `emit`/`exit` play the pty's side. Each gets a pid of its own,
 * as each pty leads its own group */
export class FakeTerminal implements PtyHandle {
  pid = nextFakePid++;
  alive = true;
  cols: number;
  rows: number;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  kills = 0;
  private ring = "";
  constructor(
    readonly opts: PtyOpts,
    private onData: (data: string) => void,
    private onExit: (exitCode: number) => void,
  ) {
    this.cols = opts.cols;
    this.rows = opts.rows;
  }
  write(data: string) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
    this.cols = cols;
    this.rows = rows;
  }
  async kill() {
    this.kills++;
    this.exit(0);
  }
  snapshot() {
    return this.ring;
  }
  emit(data: string) {
    this.ring += data;
    this.onData(data);
  }
  exit(code: number) {
    if (!this.alive) return;
    this.alive = false;
    this.onExit(code);
  }
}

/** two always-launchable agents (the command is `true`), so services validate ids without npm.
 * `dir` is where a package agent would be installed, and these are commands, so nothing is written
 * there: a caller with a temp home passes its agentsDir so its cleanup takes it, and one without
 * passes a path that does not exist */
export function fakeAgents(dir: string): AgentRegistry {
  const spec = (id: string, extra: Partial<AgentSpec> = {}): AgentSpec => ({
    id,
    name: id,
    builtin: true,
    run: { kind: "command", command: "true" },
    confinement: "none",
    systemPrompt: "prompt-prefix",
    loginHint: `${id}: log in`,
    ...extra,
  });
  return new AgentRegistry([spec("claude"), spec("codex", { mode: "agent" })], dir);
}

/** Nothing to connect to by default: a test that reads the cache needs no adapter, and one that
 * signs an agent out or looks at one passes an in-process connect of its own. */
export function fakeReadiness(agents: AgentRegistry, connect?: AgentReadinessDeps["connect"]): AgentReadiness {
  return new AgentReadiness({
    infos: () => agents.infos(),
    require: (id) => agents.require(id),
    connect:
      connect ??
      (() => {
        throw new Error("fakeReadiness: no adapter to connect to");
      }),
    cwd: "/nowhere",
    options: () => [],
    runs: () => undefined,
    picks: () => ({}),
    learned: () => {},
    quick: () => false,
  });
}

/** RuntimeDeps factories that build the fakes above and remember them by worktree id */
export function fakeFactories() {
  /** what a fake agent's `atRest` asks, once a world has a handoff service to answer */
  const rest: { of: ((worktreeId: string) => boolean) | null } = { of: null };
  const agents = new Map<string, FakeAgent>();
  const procs = new Map<string, FakeProcs>();
  const proxies = new Map<string, FakeProxy>();
  /** every forwarder made, in order; the registry keeps them by worktree and proc name */
  const forwards: FakeForwarder[] = [];
  /** every terminal spawned per worktree, in order (a dead one is respawned on the next open) */
  const terminals = new Map<string, FakeTerminal[]>();
  const factories: Pick<RuntimeDeps, "makeAgent" | "makeProcs" | "makeForward" | "makeProxy" | "makeTerminal"> = {
    makeForward: (opts) => {
      const f = new FakeForwarder(opts);
      forwards.push(f);
      return f;
    },
    makeTerminal: (wt, opts, onData, onExit) => {
      const t = new FakeTerminal(opts, onData, onExit);
      terminals.set(wt.id, [...(terminals.get(wt.id) ?? []), t]);
      return t;
    },
    makeAgent: (wt: WorktreeInfo, _deps, _preview, onProcess) => {
      const a = new FakeAgent(wt.id);
      a.onProcess = onProcess;
      a.atRest = () => rest.of?.(wt.id) ?? false;
      agents.set(wt.id, a);
      return a;
    },
    makeProcs: (wt: WorktreeInfo) => {
      const p = new FakeProcs();
      procs.set(wt.id, p);
      return p as unknown as WorktreeProcs;
    },
    makeProxy: (wt: WorktreeInfo) => {
      const p = new FakeProxy(wt.proxyPort);
      proxies.set(wt.id, p);
      return p;
    },
  };
  return { factories, agents, procs, proxies, forwards, terminals, rest };
}
