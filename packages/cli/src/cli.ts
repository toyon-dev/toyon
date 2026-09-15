#!/usr/bin/env bun
// `toyon [path]`: ensure the daemon is running, register the repo, open the shell. The verbs
// (stop, doctor, logs, version) are the operator surface a stranger needs to make it go away
// again. Runs under bun from the source tree; the npm shim replaces this shebang.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { installApp, openAppWindow } from "./app.ts";
import { type Command, HELP, parseArgs } from "./args.ts";
import { base, health, logFile, port, readToken, shellUrl, startDaemon } from "./daemon.ts";
import { deploy } from "./deploy/fly.ts";
import { doctor } from "./doctor.ts";
import { logs } from "./logs.ts";
import { openUrl } from "./openUrl.ts";
import { remote } from "./remote.ts";
import { restart } from "./restart.ts";
import {
  bwrapBlockedAdvice,
  bwrapStartError,
  missingSandboxTools,
  sandboxAdvice,
  userNamespacesRestricted,
} from "./sandboxDeps.ts";
import { stop } from "./stop.ts";
import { uninstall } from "./uninstall.ts";

async function open(cmd: Extract<Command, { kind: "open" }>): Promise<number> {
  // an explicit path is registered whatever it is (the daemon says if it is not a repo); a bare
  // `toyon` registers the cwd only when it is one, and otherwise just opens the shell, whose
  // project picker can create or clone from there
  const explicit = cmd.path !== null;
  const target = resolve(cmd.path ?? process.cwd());
  const register = explicit || existsSync(join(target, ".git"));

  // agent sandboxes on Linux need bubblewrap and socat, which a plain install often lacks, and
  // Ubuntu 24.04 and later stop an installed bubblewrap starting until AppArmor allows it
  if (process.platform === "linux") {
    const missing = missingSandboxTools();
    const blocked = missing.length === 0 ? bwrapStartError() : null;
    if (missing.length > 0) console.log(sandboxAdvice(missing));
    else if (blocked) console.log(bwrapBlockedAdvice(blocked, userNamespacesRestricted()));
  }

  if (!(await health())) {
    console.log("starting Toyon daemon…");
    if (!(await startDaemon())) {
      console.error(`daemon failed to start; \`toyon logs\` shows why (${logFile})`);
      return 1;
    }
  }

  const token = readToken();
  if (!token) {
    console.error("daemon token missing; `toyon doctor` says where it looked");
    return 1;
  }

  if (register) {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    if (!res.ok) {
      console.error(`could not open ${target}: ${await res.text()}`);
      if (explicit || (!cmd.app && !cmd.installApp)) return 1;
    }
  }

  // prefer the branded URL; browsers hardwire *.localhost to loopback
  const branded = (await health())?.branded === true;
  const url = shellUrl(token, branded);
  // app windows use the always-bound port so they never hit a dead :80
  const appUrl = `http://toyon.localhost:${port}/#token=${token}`;

  if (cmd.installApp) {
    installApp(appUrl);
  } else if (cmd.app) {
    console.log(`toyon: app window (${appUrl.split("#")[0]})`);
    if (!openAppWindow(appUrl)) {
      console.log("no Chromium browser found; opening in default browser");
      openUrl(url);
    }
  } else {
    console.log(`toyon: ${url}`);
    openUrl(url);
  }
  const remote = (await health())?.remote;
  if (remote) console.log(`toyon: remote at https://${remote.host}/#token=${token}`);
  return 0;
}

async function run(cmd: Command): Promise<number> {
  switch (cmd.kind) {
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "error":
      console.error(`toyon: ${cmd.message}\n`);
      process.stderr.write(HELP);
      return 2;
    case "version": {
      const h = await health();
      if (!h) console.log(`toyon ${pkg.version}`);
      else if (h.version === pkg.version) console.log(`toyon ${pkg.version} (daemon ${h.version} running)`);
      // a daemon too old to report its version is still one a restart replaces
      else console.log(`toyon ${pkg.version} (daemon ${h.version ?? "?"} running; \`toyon restart\` to update)`);
      return 0;
    }
    case "stop":
      return stop();
    case "restart":
      return restart();
    case "doctor":
      return doctor();
    case "logs":
      return logs(cmd);
    case "uninstall":
      return uninstall(cmd);
    case "remote":
      return remote(cmd);
    case "deploy":
      return deploy(cmd);
    case "open":
      return open(cmd);
  }
}

// the exit code, not process.exit(): `open` hands the URL to a child that has to get off the ground
// before this process is gone, and the loop draining is what guarantees that
process.exitCode = await run(parseArgs(process.argv.slice(2)));
