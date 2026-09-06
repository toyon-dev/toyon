// An ACP agent as a child process: spawn it, frame its stdio as JSON-RPC, and give the session a
// handle it can kill. The session never sees a ChildProcess; tests connect the same client app to
// an in-process agent instead.

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { log } from "../../core/log.ts";
import { killProcessGroup } from "../../runtime/kill.ts";
import type { Launch } from "../registry.ts";

export interface AcpLink {
  conn: acp.ClientConnection;
  /** SIGTERM the group, SIGKILL after 3s; resolves when the process is gone */
  kill(): Promise<void>;
  /** resolves when the process exits, however it exits */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** once exited: how, plus the last lines it wrote to stderr; null while alive */
  exitInfo(): string | null;
}

export function spawnAcp(app: acp.ClientApp, launch: Launch, cwd: string, tag: string): AcpLink {
  // detached => own process group, so a kill reaches the agent the adapter spawns underneath it
  const child = spawn(launch.command, launch.args, {
    cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...launch.env },
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    // a spawn failure (ENOENT, EACCES) emits error and never exit; unhandled it would kill the daemon
    child.once("error", (e) => {
      log.warn(tag, `agent process error: ${e.message}`);
      resolve({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let stderrTail = "";
  child.stderr!.on("data", (buf: Buffer) => {
    stderrTail = (stderrTail + buf.toString()).slice(-2000);
    for (const line of buf.toString().split("\n")) if (line.trim()) log.debug(tag, `agent: ${line}`);
  });
  let exitInfo: string | null = null;
  const stream = acp.ndJsonStream(
    // node's stream typings and the SDK's web-stream typings disagree on the chunk type only
    Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );
  const conn = app.connect(stream);
  // an exited process can answer nothing: fail whatever is pending instead of hanging a turn
  // (the SDK usually notices the closed pipe first; exitInfo carries the detail either way)
  exited.then(({ code, signal }) => {
    const why = signal ? `signal ${signal}` : `code ${code}`;
    const tail = stderrTail.trim().split("\n").slice(-3).join(" | ");
    exitInfo = `agent process exited (${why})${tail ? `: ${tail}` : ""}`;
    conn.close(new Error(exitInfo));
  });
  return { conn, kill: () => killProcessGroup(child), exited, exitInfo: () => exitInfo };
}
