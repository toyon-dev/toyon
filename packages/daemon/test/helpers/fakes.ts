import type { AgentCommand, AgentEvent, AgentStatus, LogLine, ProcState, WorktreeInfo } from "@toyon/shared";
import { AgentAccounts, type AgentAccountsDeps } from "../../src/agent/accounts.ts";
import type { AgentAdapter, AskOpts, AskReply, SendOpts } from "../../src/agent/adapter.ts";
import { AgentRegistry, type AgentSpec } from "../../src/agent/registry.ts";
import type { PreviewHandler, WorktreeProxy } from "../../src/runtime/proxy.ts";
import type { PtyHandle, PtyOpts } from "../../src/runtime/pty.ts";
import type { RuntimeDeps } from "../../src/runtime/registry.ts";
import type { WorktreeProcs } from "../../src/runtime/supervisor.ts";

export class FakeAgent implements AgentAdapter {
  status: AgentStatus = "idle";
  sent: Array<{ text: string } & SendOpts> = [];
  stops = 0;
  onQueueChange: (() => void) | null = null;
  commands: AgentCommand[] = [];
  onCommandsChange: ((commands: AgentCommand[]) => void) | null = null;
  warms = 0;
  /** the agent whose process is up; the warm-up counts as spawning the registry's default */
  runningAgent: string | null = null;
  async warmCommands() {
    await this.warm();
  }
  async warm() {
    this.warms++;
    this.runningAgent ??= "claude";
  }
  restarts = 0;
  async restart() {
    this.restarts++;
    this.runningAgent = null;
  }
  constructor(readonly worktreeId: string) {}
  get queueLength() {
    return 0;
  }
  get queueItems(): string[] {
    return [];
  }
  unsettled = false;
  send(text: string, opts: SendOpts = {}) {
    this.sent.push({ text, ...opts });
  }
  stop() {
    this.stops++;
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
  answered: Array<[string, AskReply]> = [];
  answer(askId: string, reply: AskReply) {
    this.answered.push([askId, reply]);
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
  unqueue() {}
  /** what the daemon put on the transcript itself (exec results); an agent's own events never
   * reach a fake */
  recorded: AgentEvent[] = [];
  note(event: AgentEvent) {
    this.recorded.push(event);
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
    const st: ProcState = { name, command, port: 40000 + this.started.length, status: "running", host: "127.0.0.1" };
    this.states_.push(st);
    return st;
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
  pgids(): number[] {
    return [];
  }
  restarts: string[] = [];
  restart(name: string) {
    this.restarts.push(name);
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

/** records writes/resizes/kills; `emit`/`exit` play the pty's side */
export class FakeTerminal implements PtyHandle {
  pid = 4242;
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
 * signs an agent out passes an in-process connect of its own. */
export function fakeAccounts(agents: AgentRegistry, connect?: AgentAccountsDeps["connect"]): AgentAccounts {
  return new AgentAccounts({
    require: (id) => agents.require(id),
    connect:
      connect ??
      (() => {
        throw new Error("fakeAccounts: no adapter to connect to");
      }),
  });
}

/** RuntimeDeps factories that build the fakes above and remember them by worktree id */
export function fakeFactories() {
  const agents = new Map<string, FakeAgent>();
  const procs = new Map<string, FakeProcs>();
  const proxies = new Map<string, FakeProxy>();
  /** every terminal spawned per worktree, in order (a dead one is respawned on the next open) */
  const terminals = new Map<string, FakeTerminal[]>();
  const factories: Pick<RuntimeDeps, "makeAgent" | "makeProcs" | "makeProxy" | "makeTerminal"> = {
    makeTerminal: (wt, opts, onData, onExit) => {
      const t = new FakeTerminal(opts, onData, onExit);
      terminals.set(wt.id, [...(terminals.get(wt.id) ?? []), t]);
      return t;
    },
    makeAgent: (wt: WorktreeInfo) => {
      const a = new FakeAgent(wt.id);
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
  return { factories, agents, procs, proxies, terminals };
}
