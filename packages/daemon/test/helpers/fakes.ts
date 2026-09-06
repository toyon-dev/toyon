import type { AgentEvent, AgentStatus, PickMeta, ProcState, WorktreeInfo } from "@orchardist/shared";
import type { AgentAdapter } from "../../src/agent/adapter.ts";
import type { WorktreeProxy } from "../../src/runtime/proxy.ts";
import type { RuntimeDeps } from "../../src/runtime/registry.ts";
import type { WorktreeProcs } from "../../src/runtime/supervisor.ts";

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

/** RuntimeDeps factories that build the fakes above and remember them by worktree id */
export function fakeFactories() {
  const agents = new Map<string, FakeAgent>();
  const procs = new Map<string, FakeProcs>();
  const proxies = new Map<string, FakeProxy>();
  const factories: Pick<RuntimeDeps, "makeAgent" | "makeProcs" | "makeProxy"> = {
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
  return { factories, agents, procs, proxies };
}
