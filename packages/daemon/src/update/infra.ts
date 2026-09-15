// The commands that find and install a newer Toyon. Where the install sits and what a version
// string says are read in shared, so the CLI's `toyon update` reads them the same way.

import { homedir } from "node:os";
import { run, runLive } from "../git/exec.ts";

/** The newest version the registry has, asked through npm so the registry this machine is set up
 * for is the one asked, and never another: a company registry without toyon is said, not gone
 * around. `version` is null when that registry has no toyon, npm is missing, or nothing answers;
 * `registry` names the one asked, for saying so. */
export async function latestVersion(): Promise<{ version: string | null; registry: string }> {
  const config = await run("npm", ["config", "get", "registry"], homedir());
  const registry = config.ok && config.out !== "" ? config.out : "the npm registry";
  const r = await run("npm", ["view", "toyon", "version", "--json"], homedir());
  if (!r.ok) return { version: null, registry };
  try {
    const v = JSON.parse(r.out) as unknown;
    return { version: typeof v === "string" ? v : null, registry };
  } catch {
    // npm printed something other than the JSON asked for; the next check asks again
    return { version: null, registry };
  }
}

/** npm ends every failure by pointing at its log, which says nothing about what went wrong */
const LOG_POINTER = /complete log of this run/i;

/** Run an install. Answers whether it worked and the last line worth reading, which is what a
 * failure shows. */
export async function runInstall(command: string[]): Promise<{ ok: boolean; line: string }> {
  const [cmd, ...args] = command;
  if (!cmd) return { ok: false, line: "nothing to run" };
  const r = await runLive(cmd, args, homedir());
  const lines = `${r.out}\n${r.err}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !LOG_POINTER.test(l));
  return { ok: r.ok, line: lines.at(-1) ?? String(r.exit) };
}
