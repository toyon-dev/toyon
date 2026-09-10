// What every verb needs to know about the daemon on this machine: where its home is, whether it
// answers, what its token is, and how to start one. Read from the environment once, here.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_DEFAULT_PORT, DAEMON_FILES } from "@toyon/shared";
import { daemonEntry } from "./layout.ts";

export const port = Number(process.env.TOYON_PORT ?? DAEMON_DEFAULT_PORT);
export const base = `http://127.0.0.1:${port}`;
export const home = process.env.TOYON_HOME ?? join(homedir(), ".toyon");
export const tokenFile = join(home, DAEMON_FILES.token);
export const pidFile = join(home, DAEMON_FILES.pid);
export const logFile = join(home, DAEMON_FILES.log);

export interface Health {
  ok: boolean;
  version?: string;
  pid?: number;
  branded?: boolean;
  lag?: { last: number; max: number; maxCause: string | null; over: number };
  worktrees?: { total: number; running: number };
}

/** null when nothing answers on the port within a second */
export async function health(): Promise<Health | null> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) return null;
    return (await r.json()) as Health;
  } catch {
    return null;
  }
}

export function readToken(): string | null {
  if (!existsSync(tokenFile)) return null;
  const t = readFileSync(tokenFile, "utf8").trim();
  return t === "" ? null : t;
}

/** the pid the daemon wrote, or null when there is no file or it does not parse */
export function readPid(): number | null {
  if (!existsSync(pidFile)) return null;
  const n = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** spawns a detached daemon logging to the log file and waits for it to answer; false on timeout */
export async function startDaemon(): Promise<boolean> {
  // the daemon makes its home on boot, but its log is opened here first: on a machine's very
  // first `npx toyon` nothing has made the directory yet
  mkdirSync(home, { recursive: true });
  const logFd = openSync(logFile, "a");
  // the bun running this CLI, not whatever `bun` is on PATH: under npx that is the bundled one
  const child = spawn(process.execPath, ["run", daemonEntry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  child.on("error", (e) => console.error(`could not start bun: ${e.message}`));
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await health()) return true;
    await Bun.sleep(250);
  }
  return (await health()) !== null;
}

/** the shell's address: the portless branded host when the daemon bound it, else the port */
export function shellUrl(token: string, branded: boolean): string {
  return branded ? `http://toyon.localhost/#token=${token}` : `http://toyon.localhost:${port}/#token=${token}`;
}
