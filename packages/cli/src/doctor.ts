// `toyon doctor`: everything a "connecting to daemon" that never resolves could mean, checked from
// the terminal and named. Exit 1 when any line fails, so it can gate a bug report.

import { existsSync, statSync } from "node:fs";
import { WS_CLOSE_UNAUTHORIZED } from "@toyon/shared";
import pkg from "../package.json" with { type: "json" };
import { alive, base, health, home, logFile, port, readPid, readToken, tokenFile } from "./daemon.ts";

type Line = { ok: boolean; label: string; detail: string };

function line(ok: boolean, label: string, detail: string): Line {
  return { ok, label, detail };
}

async function toolVersion(cmd: string, args: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return p.exitCode === 0 ? out.trim().split("\n")[0]! : null;
  } catch {
    return null;
  }
}

/** the same handshake the shell makes; resolves with what the daemon said about the token. The
 * socket opening proves nothing, since a wrong token is opened and then closed with a code: the
 * daemon's first frame (its hello) is what an accepted token looks like. */
function handshake(token: string): Promise<"ok" | "unauthorized" | "blocked"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const timer = setTimeout(() => {
      ws.close();
      resolve("blocked");
    }, 3000);
    ws.onmessage = () => {
      clearTimeout(timer);
      ws.close();
      resolve("ok");
    };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      resolve(ev.code === WS_CLOSE_UNAUTHORIZED ? "unauthorized" : "blocked");
    };
  });
}

export async function doctor(): Promise<number> {
  const lines: Line[] = [];
  lines.push(line(true, "cli", `toyon ${pkg.version}, bun ${Bun.version}, ${process.platform} ${process.arch}`));
  lines.push(line(true, "home", home));

  const git = await toolVersion("git", ["--version"]);
  lines.push(git ? line(true, "git", git) : line(false, "git", "not found on PATH; toyon needs git 2.x"));

  const h = await health();
  if (!h) {
    const pid = readPid();
    const stale = pid !== null && !alive(pid);
    lines.push(
      line(
        false,
        "daemon",
        stale
          ? `not running at ${base}; ${pid} in daemon.pid is dead, so it did not exit cleanly. \`toyon logs\` has its last words`
          : pid !== null
            ? `pid ${pid} is alive but nothing answers at ${base}; it may still be booting, or another program holds the port`
            : `not running at ${base}; \`toyon\` starts it`,
      ),
    );
  } else {
    const version = h.version ?? "?";
    lines.push(
      line(
        true,
        "daemon",
        `${version} at ${base}, pid ${h.pid ?? "?"}${h.branded ? ", also http://toyon.localhost" : ""}` +
          (h.lag ? `, event loop worst ${h.lag.max}ms${h.lag.maxCause ? ` (${h.lag.maxCause})` : ""}` : ""),
      ),
    );
    if (h.worktrees) {
      const { total, running } = h.worktrees;
      lines.push(line(true, "running", `${running} of ${total} worktrees started; the rest start when opened`));
    }
    if (version !== pkg.version) {
      lines.push(
        line(
          false,
          "version",
          `cli is ${pkg.version} and the daemon is ${version}; \`toyon stop\` then \`toyon\` restarts it`,
        ),
      );
    }
  }

  const token = readToken();
  if (!token) {
    lines.push(line(false, "token", `${tokenFile} is missing; the daemon writes it on first start`));
  } else if (h) {
    const r = await handshake(token);
    lines.push(
      r === "ok"
        ? line(true, "websocket", "handshake accepted with the token on disk")
        : r === "unauthorized"
          ? line(false, "websocket", "the daemon refused the token on disk; it was started with another TOYON_HOME")
          : line(
              false,
              "websocket",
              "the daemon answers HTTP but the websocket never opened; a proxy or VPN in the way?",
            ),
    );
  } else {
    lines.push(line(true, "token", "present"));
  }

  if (h) {
    try {
      const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) });
      const body = await r.text();
      const built = r.ok && !body.startsWith("toyon daemon running; shell not built");
      lines.push(
        built
          ? line(true, "shell", "served")
          : line(false, "shell", "not built: run `bun run build` in the toyon checkout"),
      );
    } catch (e) {
      lines.push(line(false, "shell", `could not fetch: ${(e as Error).message}`));
    }
  }

  if (existsSync(logFile)) {
    const kb = Math.round(statSync(logFile).size / 1024);
    lines.push(line(true, "log", `${logFile} (${kb} KB)`));
  }

  const width = Math.max(...lines.map((l) => l.label.length));
  for (const l of lines) {
    console.log(`${l.ok ? "ok  " : "FAIL"} ${l.label.padEnd(width)}  ${l.detail}`);
  }
  return lines.every((l) => l.ok) ? 0 : 1;
}
