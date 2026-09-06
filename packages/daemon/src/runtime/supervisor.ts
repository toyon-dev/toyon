import { type ChildProcess, spawn } from "node:child_process";
import type { ProcState } from "@toyon/shared";
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

    // a spawn failure (cwd removed, sh missing) emits 'error' with no 'exit'; unhandled it kills the daemon
    child.on("error", (e) => {
      if (this.stopped || mp.state.status === "stopped" || mp.state.status === "crashed") return;
      mp.state.status = "crashed";
      this.onProc({ ...mp.state });
      this.onLog(name, `failed to start: ${e.message}`);
    });

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
            socket: {
              data() {},
              open(s) {
                s.end();
              },
            },
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

  /** SIGTERM the process group, SIGKILL after 3s. Resolves once the child has exited (or shortly
   * after the SIGKILL), so a daemon shutdown can wait for its dev servers instead of orphaning them. */
  private killProc(mp: ManagedProc): Promise<void> {
    const child = mp.child;
    const pid = child?.pid;
    if (!child || !pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve();
      };
      child.once("exit", finish);
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // group already gone: nothing to wait for
        finish();
        return;
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // group already gone
        }
        // the exit event follows the SIGKILL almost immediately; don't hang on a stuck one
        setTimeout(finish, 200);
      }, 3000);
    });
  }

  /** Stop every proc; resolves when they have all exited (bounded by the SIGKILL grace). */
  async stopAll(): Promise<void> {
    this.stopped = true;
    const exits: Promise<void>[] = [];
    for (const mp of this.procs.values()) {
      mp.state.status = "stopped";
      exits.push(this.killProc(mp));
      releasePort(mp.state.port);
    }
    await Promise.all(exits);
  }

  /** the tail of every proc's log ring, oldest first, in the shell's `[proc] line` format */
  recentLogs(limit = 200): string[] {
    const out: string[] = [];
    for (const mp of this.procs.values()) for (const line of mp.logs) out.push(`[${mp.state.name}] ${line}`);
    return out.slice(-limit);
  }

  states(): ProcState[] {
    return [...this.procs.values()].map((p) => ({ ...p.state }));
  }
}
