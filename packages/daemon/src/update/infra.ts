// The commands that find and install a newer Toyon. Where the install sits and what a version
// string says are read in shared, so the CLI's `toyon update` reads them the same way.

import { homedir } from "node:os";
import { run, runLive } from "../git/exec.ts";

/** The newest version the registry has, asked through npm so the registry this machine is set up
 * for is the one asked. Null when npm is missing or the registry does not answer. */
export async function latestVersion(): Promise<string | null> {
  const r = await run("npm", ["view", "toyon", "version", "--json"], homedir());
  if (!r.ok) return null;
  try {
    const v = JSON.parse(r.out) as unknown;
    return typeof v === "string" ? v : null;
  } catch {
    // npm printed something other than the JSON asked for; the next check asks again
    return null;
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
