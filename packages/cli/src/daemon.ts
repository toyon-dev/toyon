// What every verb needs to know about the daemon on this machine: where its home is, whether it
// answers, what its token is, and how to start one. Read from the environment once, here.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_DEFAULT_PORT, DAEMON_FILES, newer, type RemoteView, type TailscaleReadiness } from "@toyon/shared";
import pkg from "../package.json" with { type: "json" };
import { daemonEntry, restartCmd } from "./layout.ts";

export const port = Number(process.env.TOYON_PORT ?? DAEMON_DEFAULT_PORT);
export const base = `http://127.0.0.1:${port}`;
export const home = process.env.TOYON_HOME ?? join(homedir(), ".toyon");
export const tokenFile = join(home, DAEMON_FILES.token);
export const pidFile = join(home, DAEMON_FILES.pid);
export const logFile = join(home, DAEMON_FILES.log);
export const remoteFile = join(home, DAEMON_FILES.remote);

export interface Health {
  ok: boolean;
  version?: string;
  pid?: number;
  branded?: boolean;
  /** the public name as the daemon holds it now; null when remote access is off */
  remote?: RemoteView | null;
  /** whether Tailscale on that machine could hold a name, and what is missing if not */
  tailscale?: TailscaleReadiness;
  lag?: { last: number; max: number; maxCause: string | null; over: number };
  worktrees?: { total: number; running: number };
  /** updates turned off for the machine and by whom, the registry they come from, or one the
   * daemon could not get toyon from */
  updates?: {
    managedBy: "policy" | "env" | null;
    registry: string | null;
    unreachable: string | null;
    latest: string | null;
  };
  /** each agent adapter's version on disk beside the one the daemon pins, and why the last install
   * did not land */
  agents?: { id: string; installed: string | null; pinned: string; error?: string }[];
  /** the managed policy the daemon booted under: where it came from, and a hash of it */
  managed?: { source: string | null; hash: string | null };
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

/** A request to the running daemon behind its token: `path` under its base, a JSON body when one
 * is given. Null when the daemon did not answer at all, which the verbs read as "not running". */
export async function daemonFetch(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response | null> {
  const token = readToken();
  if (!token) return null;
  try {
    return await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
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

/** A running daemon older than this CLI: an install landed and nothing restarted it. One too old to
 * report its version is older too. A newer daemon is not one a restart from here should replace. */
export function behind(daemonVersion: string | undefined): boolean {
  return daemonVersion === undefined || newer(pkg.version, daemonVersion);
}

export interface Daemon {
  token: string;
  /** the shell's address: the portless branded host when the daemon bound it, else the port */
  url: string;
  /** the public name the daemon started with; null when remote access is off */
  remote: RemoteView | null;
}

/** a daemon up, with its token and address in hand, or null with the reason already printed */
export async function ensureDaemon(): Promise<Daemon | null> {
  let running = await health();
  if (!running) {
    console.log("starting Toyon daemon…");
    running = (await startDaemon()) ? await health() : null;
    if (!running) {
      console.error(`daemon failed to start; \`toyon logs\` shows why (${logFile})`);
      return null;
    }
  } else if (behind(running.version)) {
    // what opens is served by the running daemon, so say it is not the one installed
    console.log(`toyon: the running daemon is ${running.version ?? "older"}; \`${restartCmd}\` starts ${pkg.version}`);
  }
  const token = readToken();
  if (!token) {
    console.error("daemon token missing; `toyon doctor` says where it looked");
    return null;
  }
  return { token, url: shellUrl(token, running.branded === true), remote: running.remote ?? null };
}

/** a request to the daemon behind the token */
export function post(route: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** the shell's address: the portless branded host when the daemon bound it, else the port */
export function shellUrl(token: string, branded: boolean): string {
  return branded ? `http://toyon.localhost/#token=${token}` : `http://toyon.localhost:${port}/#token=${token}`;
}
