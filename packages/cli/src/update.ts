// `toyon update`: install the newest Toyon the way this one was installed, then have the running
// daemon restart onto it. The restart goes through the daemon's own /restart, so a chat mid-reply
// finishes first, the same as the update chip in the app.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { installCommand, installMethod, newer } from "@toyon/shared";
import pkg from "../package.json" with { type: "json" };
import { base, health, readToken } from "./daemon.ts";
import { here, packaged } from "./layout.ts";

/** how long to watch for the new daemon before saying it is waiting on a reply */
const WAIT_MS = 15_000;

export async function update(): Promise<number> {
  // the switch whoever runs the machine sets holds for the terminal too, not only the app
  if (process.env.TOYON_UPDATES === "off") {
    console.error("updates are turned off for this machine (TOYON_UPDATES=off)");
    return 1;
  }
  const method = installMethod(packaged ? join(here, "..", "package.json") : null);
  if (method === "none") {
    console.error(
      "toyon update works on a global npm or bun install, and this Toyon is not one; update it the way it was installed",
    );
    return 1;
  }
  const latest = latestVersion();
  if (latest === null) {
    console.error("could not ask npm for the newest Toyon; check that npm is on your PATH and its registry answers");
    return 1;
  }
  const behind = newer(latest, pkg.version);
  if (method === "npx") {
    console.log(
      behind
        ? `toyon ${latest} is out; npx runs the version you name, so run npx toyon@${latest}`
        : `toyon ${pkg.version} is the newest`,
    );
    return 0;
  }
  if (behind) {
    const command = installCommand(method, latest) ?? [];
    const [cmd, ...args] = command;
    if (!cmd) return 1;
    console.log(`installing toyon ${latest}: ${command.join(" ")}`);
    const r = spawnSync(cmd, args, { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`the install did not finish; run ${command.join(" ")} yourself to see why`);
      return r.status ?? 1;
    }
  } else {
    console.log(`toyon ${pkg.version} is the newest`);
  }
  return restartOnto(behind ? latest : pkg.version);
}

/** the newest version npm's registry has, or null when npm cannot say */
function latestVersion(): string | null {
  const r = spawnSync("npm", ["view", "toyon", "version", "--json"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    const v = JSON.parse(r.stdout) as unknown;
    return typeof v === "string" ? v : null;
  } catch {
    // npm printed something other than the JSON asked for
    return null;
  }
}

/** Ask a running daemon to restart onto `version`, and say whether it has. */
async function restartOnto(version: string): Promise<number> {
  const h = await health();
  if (!h) {
    console.log(`Toyon is not running; \`toyon\` starts ${version}`);
    return 0;
  }
  if (h.version === version) {
    console.log(`the daemon is already ${version}`);
    return 0;
  }
  const token = readToken();
  if (!token) {
    console.error(
      "the daemon token is missing, so the daemon cannot be asked to restart; `toyon restart` does it by hand",
    );
    return 1;
  }
  const res = await fetch(`${base}/restart?token=${token}`, { method: "POST" }).catch(() => null);
  if (res && res.status === 409) {
    console.error(await res.text());
    return 1;
  }
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(500);
    if ((await health())?.version === version) {
      console.log(`restarted Toyon on ${version}`);
      return 0;
    }
  }
  console.log(`Toyon restarts on ${version} once the chat replying now finishes`);
  return 0;
}
