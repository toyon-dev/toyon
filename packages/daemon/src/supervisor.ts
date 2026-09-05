import { spawn, type ChildProcess } from "node:child_process";
import type { ProcState } from "@orchardist/shared";
import { allocatePort, releasePort } from "./ports.ts";

const LOG_RING_SIZE = 500;

export interface ManagedProc {
  state: ProcState;
  child?: ChildProcess;
  logs: string[];
  env: Record<string, string>;
  restarts: number;
  lastStart: number;
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
      env: extraEnv,
      restarts: 0,
      lastStart: 0,
    };
    this.procs.set(name, mp);
    this.spawnProc(mp);
    return mp.state;
  }

  private spawnProc(mp: ManagedProc) {
    if (this.stopped) return;
    const { name, command, port } = mp.state;
    mp.lastStart = Date.now();
    // detached => own process group, so kill(-pid) reaps script children too
    const child = spawn("sh", ["-c", command], {
      cwd: this.worktreePath,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), FORCE_COLOR: "0", ...mp.env },
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
      // crash auto-restart with backoff; a healthy minute resets the counter
      if (mp.state.status === "crashed") {
        if (Date.now() - mp.lastStart > 60_000) mp.restarts = 0;
        if (mp.restarts < 5) {
          mp.restarts += 1;
          const delay = Math.min(30_000, 1000 * 2 ** (mp.restarts - 1));
          this.onLog(name, `crashed (exit ${code}) — restarting in ${delay / 1000}s (attempt ${mp.restarts}/5)`);
          setTimeout(() => {
            if (!this.stopped && mp.state.status === "crashed") this.spawnProc(mp);
          }, delay);
        } else {
          this.onLog(name, `crashed (exit ${code}) — giving up after 5 attempts; restart manually`);
        }
      }
    });

    // "running" once the port accepts connections
    this.pollPort(mp);
  }

  private async pollPort(mp: ManagedProc) {
    const { port } = mp.state;
    for (let i = 0; i < 120; i++) {
      if (this.stopped || mp.state.status === "crashed" || mp.state.status === "stopped") return;
      // dev servers bind whichever family "localhost" resolves to first — try both
      for (const hostname of ["127.0.0.1", "::1"]) {
        try {
          const sock = await Bun.connect({
            hostname,
            port,
            socket: { data() {}, open(s) { s.end(); } },
          });
          sock.end();
          mp.state.host = hostname;
          mp.state.status = "running";
          this.onProc({ ...mp.state });
          return;
        } catch {}
      }
      await Bun.sleep(500);
    }
  }

  restart(name: string) {
    const mp = this.procs.get(name);
    if (!mp) return;
    mp.restarts = 0;
    if (mp.state.status === "crashed") {
      this.spawnProc(mp);
    } else {
      // mark stopped first so the exit handler doesn't schedule a crash-restart
      mp.state.status = "stopped";
      this.killProc(mp);
      setTimeout(() => this.spawnProc(mp), 300);
    }
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
