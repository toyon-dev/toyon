#!/usr/bin/env bun
// `orchardist` in a repo: ensure the daemon is running, register the cwd repo,
// open the shell in the default browser.
// v0.1 runs under bun (dev-mode); packaged single-binary distribution comes later.

import { spawn } from "node:child_process";
import { readFileSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_DEFAULT_PORT } from "@orchardist/shared";

const port = Number(process.env.ORCHARDIST_PORT ?? DAEMON_DEFAULT_PORT);
const base = `http://127.0.0.1:${port}`;
const tokenFile = join(homedir(), ".orchardist", "token");
const here = dirname(fileURLToPath(import.meta.url));
const daemonEntry = join(here, "../../daemon/src/index.ts");

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

if (!(await healthy())) {
  console.log("starting orchardist daemon…");
  const logFd = openSync(join(homedir(), ".orchardist", "daemon.log"), "a");
  const child = spawn("bun", ["run", daemonEntry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  for (let i = 0; i < 40 && !(await healthy()); i++) await Bun.sleep(250);
  if (!(await healthy())) {
    console.error("daemon failed to start; see ~/.orchardist/daemon.log");
    process.exit(1);
  }
}

if (!existsSync(tokenFile)) {
  console.error("daemon token missing; see ~/.orchardist");
  process.exit(1);
}
const token = readFileSync(tokenFile, "utf8").trim();

const res = await fetch(`${base}/register`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ path: process.cwd() }),
});
if (!res.ok) {
  console.error(`could not register repo: ${await res.text()}`);
  process.exit(1);
}

const url = `${base}/#token=${token}`;
console.log(`orchardist → ${url}`);
spawn("open", [url], { stdio: "ignore" }).unref();
