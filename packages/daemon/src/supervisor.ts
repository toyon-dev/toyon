import { spawn, type ChildProcess } from "node:child_process";
import type { ProcState } from "@orchardist/shared";
import { allocatePort, releasePort } from "./ports.ts";

const LOG_RING_SIZE = 500;

export interface ManagedProc {
  state: ProcState;
  child?: ChildProcess;
  logs: string[];
}

export type ProcListener = (proc: ProcState) => void;
export type LogListener = (proc: string, line: string) => void;

/** One process group per worktree: spawns procs, injects $PORT, kills children on stop. */
export class WorktreeProcs {
  procs = new Map<string, ManagedProc>();
  private stopped = false;

  constructor(
    readonly worktreePath: string,
    private onProc: ProcListener,
    private onLog: LogListener,
  ) {}

  async start(name: string, command: string, extraEnv: Record<string, string> = {}) {
    const port = await allocatePort();
    const mp: ManagedProc = {
      state: { name, command, port, status: "starting" },
      logs: [],
    };
    this.procs.set(name, mp);
    this.spawnProc(mp, extraEnv);
    return mp.state;
  }

  private spawnProc(mp: ManagedProc, extraEnv: Record<string, string>) {
    if (this.stopped) return;
    const { name, command, port } = mp.state;
    // detached => own process group, so kill(-pid) reaps script children too
    const child = spawn("sh", ["-c", command], {
      cwd: this.worktreePath,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), FORCE_COLOR: "0", ...extraEnv },
    });
    mp.child = child;
    mp.state.pid = child.pid;
    mp.state.status = "starting";
    this.onProc({ ...mp.state });

    const pushLines = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        mp.logs.push(line);
        if (mp.logs.length > LOG_RING_SIZE) mp.logs.shift();
        this.onLog(name, line);
      }
    };
    child.stdout?.on("data", pushLines);
    child.stderr?.on("data", pushLines);

    child.on("exit", (code) => {
      mp.state.exitCode = code;
      if (this.stopped || mp.state.status === "stopped") return;
      mp.state.status = code === 0 ? "stopped" : "crashed";
      this.onProc({ ...mp.state });
    });

    // "running" once the port accepts connections
    this.pollPort(mp);
  }

  private async pollPort(mp: ManagedProc) {
    const { port } = mp.state;
    for (let i = 0; i < 120; i++) {
      if (this.stopped || mp.state.status === "crashed" || mp.state.status === "stopped") return;
      try {
        const sock = await Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: { data() {}, open(s) { s.end(); } },
        });
        sock.end();
        mp.state.status = "running";
        this.onProc({ ...mp.state });
        return;
      } catch {
        await Bun.sleep(500);
      }
    }
  }

  restart(name: string) {
    const mp = this.procs.get(name);
    if (!mp) return;
    this.killProc(mp);
    setTimeout(() => this.spawnProc(mp, {}), 300);
  }

  private killProc(mp: ManagedProc) {
    const pid = mp.child?.pid;
    if (pid) {
      try { process.kill(-pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 3000);
    }
  }

  stopAll() {
    this.stopped = true;
    for (const mp of this.procs.values()) {
      mp.state.status = "stopped";
      this.killProc(mp);
      releasePort(mp.state.port);
    }
  }

  states(): ProcState[] {
    return [...this.procs.values()].map((p) => ({ ...p.state }));
  }
}
