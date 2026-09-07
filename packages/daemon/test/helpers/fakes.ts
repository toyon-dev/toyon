import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentStatus, PickMeta, ProcState, WorktreeInfo } from "@toyon/shared";
import type { AgentAdapter } from "../../src/agent/adapter.ts";
import { AgentRegistry, type AgentSpec } from "../../src/agent/registry.ts";
import type { WorktreeProxy } from "../../src/runtime/proxy.ts";
import type { RuntimeDeps } from "../../src/runtime/registry.ts";
import type { WorktreeProcs } from "../../src/runtime/supervisor.ts";
import type { TerminalHandle, TerminalOpts } from "../../src/runtime/terminal.ts";

export class FakeAgent implements AgentAdapter {
  status: AgentStatus = "idle";
  sent: Array<{ text: string; context?: string; pick?: PickMeta }> = [];
  stops = 0;
  onQueueChange: (() => void) | null = null;
  constructor(readonly worktreeId: string) {}
  get queueLength() {
    return 0;
  }
  get queueItems(): string[] {
    return [];
  }
  send(text: string, context?: string, pick?: PickMeta) {
    this.sent.push({ text, context, pick });
  }
  stop() {
    this.stops++;
  }
  closes = 0;
  async close() {
    this.closes++;
  }
  auths: Array<[string, string | undefined]> = [];
  async authenticate(methodId: string, apiKey?: string) {
    this.auths.push([methodId, apiKey]);
    return methodId === "terminal" ? { kind: "terminal" as const, line: "login --now" } : { kind: "done" as const };
  }
  retries = 0;
  retry() {
    this.retries++;
  }
  unqueue() {}
  transcript(): Array<{ seq: number; event: AgentEvent }> {
    return [];
  }
}

/** records starts/stops; never spawns */
export class FakeProcs {
  started: Array<{ name: string; command: string }> = [];
  stopped = false;
  private states_: ProcState[] = [];
  async start(name: string, command: string): Promise<ProcState> {
    this.started.push({ name, command });
    const st: ProcState = { name, command, port: 40000 + this.started.length, status: "running", host: "127.0.0.1" };
    this.states_.push(st);
    return st;
  }
  async stopAll() {
    this.stopped = true;
    for (const s of this.states_) s.status = "stopped";
  }
  restart() {}
  recentLogs(): string[] {
    return [];
  }
  states(): ProcState[] {
    return this.states_.map((s) => ({ ...s }));
  }
}

export class FakeProxy implements WorktreeProxy {
  stopped = false;
  constructor(readonly port: number) {}
  stop() {
    this.stopped = true;
  }
  setTarget() {}
}

/** records writes/resizes/kills; `emit`/`exit` play the pty's side */
export class FakeTerminal implements TerminalHandle {
  pid = 4242;
  alive = true;
  cols: number;
  rows: number;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  kills = 0;
  private ring = "";
  constructor(
    readonly opts: TerminalOpts,
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
  kill() {
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

/** two always-launchable agents (the command is `true`), so services validate ids without npm */
export function fakeAgents(): AgentRegistry {
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
  return new AgentRegistry(
    [spec("claude"), spec("codex", { mode: "agent" })],
    mkdtempSync(join(tmpdir(), "toyon-agents-")),
  );
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
