#!/usr/bin/env bun
// `toyon [path]`: ensure the daemon is running, register the repo, open the shell. The verbs
// (stop, doctor, logs, version) are the operator surface a stranger needs to make it go away
// again. Runs under bun from the source tree; the npm shim replaces this shebang.

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { showAppWindow } from "./app.ts";
import { type Command, HELP, parseArgs } from "./args.ts";
import { behind, ensureDaemon, health, post } from "./daemon.ts";
import { deploy } from "./deploy/fly.ts";
import { doctor } from "./doctor.ts";
import { helper } from "./helper.ts";
import { restartCmd } from "./layout.ts";
import { logs } from "./logs.ts";
import { openUrl } from "./openUrl.ts";
import { pair } from "./pair.ts";
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
import { update } from "./update.ts";

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

  const daemon = await ensureDaemon();
  if (!daemon) return 1;

  // a file is opened in the shell: in its worktree when it sits in one, on its own otherwise. The
  // daemon holds it for the window this goes on to open.
  const file = explicit && existsSync(target) && statSync(target).isFile();
  if (file) {
    const res = await post("/open", daemon.token, { path: target });
    if (!res.ok) {
      console.error(`could not open ${target}: ${await res.text()}`);
      return 1;
    }
    const opened = (await res.json()) as { kind: string };
    console.log(opened.kind === "file" ? `toyon: opening ${target} in its project` : `toyon: opening ${target}`);
  } else if (register) {
    const res = await post("/register", daemon.token, { path: target });
    if (!res.ok) {
      console.error(`could not open ${target}: ${await res.text()}`);
      if (explicit || !cmd.app) return 1;
    }
  }

  if (cmd.app) showAppWindow(daemon);
  else {
    console.log(`toyon: ${daemon.url}`);
    openUrl(daemon.url);
  }
  if (daemon.remote) console.log(`toyon: remote at https://${daemon.remote.host}/#token=${daemon.token}`);
  return 0;
}

/** `toyon start`: the daemon up, the link printed, nothing opened */
async function start(): Promise<number> {
  const daemon = await ensureDaemon();
  if (!daemon) return 1;
  console.log(`toyon: ${daemon.url}`);
  return 0;
}

async function run(cmd: Command): Promise<number> {
  switch (cmd.kind) {
    case "start":
      return start();
    case "helper":
      return helper(cmd.args);
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
      else if (!behind(h.version)) console.log(`toyon ${pkg.version} (daemon ${h.version} running)`);
      else console.log(`toyon ${pkg.version} (daemon ${h.version ?? "?"} running; \`${restartCmd}\` to update)`);
      return 0;
    }
    case "stop":
      return stop();
    case "restart":
      return restart();
    case "update":
      return update();
    case "doctor":
      return doctor();
    case "logs":
      return logs(cmd);
    case "uninstall":
      return uninstall(cmd);
    case "remote":
      return remote(cmd);
    case "pair":
      return pair();
    case "deploy":
      return deploy(cmd);
    case "open":
      return open(cmd);
  }
}

// the exit code, not process.exit(): `open` hands the URL to a child that has to get off the ground
// before this process is gone, and the loop draining is what guarantees that
process.exitCode = await run(parseArgs(process.argv.slice(2)));
