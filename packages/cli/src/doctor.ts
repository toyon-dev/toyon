// `toyon doctor`: everything a "connecting to daemon" that never resolves could mean, checked from
// the terminal and named. Exit 1 when any line fails, so it can gate a bug report.

import { existsSync, statSync } from "node:fs";
import { describeManaged, type ManagedResolved, WS_CLOSE_UNAUTHORIZED } from "@toyon/shared";
import { loadManaged } from "@toyon/shared/managed-load";
import pkg from "../package.json" with { type: "json" };
import { alive, base, type Health, health, home, logFile, port, readPid, readToken, tokenFile } from "./daemon.ts";
import {
  bwrapBlockedAdvice,
  bwrapStartError,
  missingSandboxTools,
  sandboxAdvice,
  userNamespacesRestricted,
} from "./sandboxDeps.ts";

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

/** The policy in effect: none, the file and what it turns off, or the failure that turned
 * everything off. A second line when the running daemon booted under another version of it,
 * since the daemon reads the file once and IT may have pushed a newer one since. */
export function policyLines(m: ManagedResolved, daemon: Health["managed"] | undefined): Line[] {
  const lines: Line[] = [];
  if (m.problem !== null) lines.push(line(false, "policy", `${m.problem} (everything it governs is off)`));
  else if (m.source === null) lines.push(line(true, "policy", "none"));
  else lines.push(line(true, "policy", `${m.source}: ${describeManaged(m.policy).join(", ") || "nothing turned off"}`));
  if (daemon && (daemon.source !== m.source || daemon.hash !== m.hash)) {
    lines.push(line(false, "daemon", "read an older policy; `toyon restart` applies this one"));
  }
  return lines;
}

export async function doctor(): Promise<number> {
  const lines: Line[] = [];
  lines.push(line(true, "cli", `toyon ${pkg.version}, bun ${Bun.version}, ${process.platform} ${process.arch}`));
  lines.push(line(true, "home", home));
  const managed = await loadManaged();

  const git = await toolVersion("git", ["--version"]);
  lines.push(git ? line(true, "git", git) : line(false, "git", "not found on PATH; Toyon needs git 2.x"));

  if (process.platform === "linux") {
    const missing = missingSandboxTools();
    const blocked = missing.length === 0 ? bwrapStartError() : null;
    lines.push(
      missing.length > 0
        ? line(false, "sandbox", sandboxAdvice(missing))
        : blocked
          ? line(false, "sandbox", bwrapBlockedAdvice(blocked, userNamespacesRestricted()))
          : line(true, "sandbox", "bubblewrap and socat found, and bubblewrap starts a sandbox"),
    );
  }

  const h = await health();
  lines.push(...policyLines(managed, h?.managed));
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
    if (h.remote) {
      lines.push(
        line(
          true,
          "remote",
          `https://${h.remote.host}/ through a TLS front on 127.0.0.1:${port}, previews at ${h.remote.previews}`,
        ),
      );
    }
    if (h.worktrees) {
      const { total, running } = h.worktrees;
      lines.push(line(true, "running", `${running} of ${total} worktrees started; the rest start when opened`));
    }
    if (version !== pkg.version) {
      lines.push(
        line(
          false,
          "version",
          `cli is ${pkg.version} and the daemon is ${version}; \`toyon restart\` brings them level`,
        ),
      );
    }
    // updates only go through the registry npm is set up for, so a registry without toyon is said
    // here rather than gone around
    if (h.updates?.managedBy === "policy") {
      lines.push(line(true, "updates", "off by your organization's policy"));
    } else if (h.updates?.managedBy === "env") {
      lines.push(line(true, "updates", "off for this machine (TOYON_UPDATES=off)"));
    } else if (h.updates?.unreachable) {
      lines.push(
        line(
          false,
          "updates",
          `npm could not get toyon from ${h.updates.unreachable}, so Toyon cannot update itself; if you may use the public registry, run npm install -g toyon --registry=https://registry.npmjs.org/`,
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
      const built = r.ok && !body.startsWith("Toyon daemon running; shell not built");
      lines.push(
        built
          ? line(true, "shell", "served")
          : line(false, "shell", "not built: run `bun run build` in the Toyon checkout"),
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
