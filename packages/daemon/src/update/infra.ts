// How this Toyon was installed, and the commands that find and install a newer one. The daemon
// cannot import the CLI's code, so `toyon update` keeps its own copy of the same detection.

import { homedir } from "node:os";
import type { InstallMethod } from "@toyon/shared";
import { run, runLive } from "../git/exec.ts";

/** Read from where the installed package.json sits. npm keeps global packages under a
 * node_modules in its prefix, bun under .bun/install/global, and npx runs a copy out of its own
 * cache, which a newer version never replaces. */
export function installMethod(packageJson: string | null): InstallMethod {
  if (!packageJson) return "none";
  const p = packageJson.replaceAll("\\", "/");
  if (p.includes("/_npx/")) return "npx";
  if (p.includes("/.bun/install/global/")) return "bun";
  if (p.includes("/node_modules/toyon/")) return "npm";
  return "none";
}

/** The command that installs `version`, which is also what a person runs when the install from
 * here fails. Null where nothing installs: npx runs whatever version it is asked for. */
export function installCommand(method: InstallMethod, version: string): string[] | null {
  if (method === "npm") return ["npm", "install", "-g", `toyon@${version}`];
  if (method === "bun") return ["bun", "add", "-g", `toyon@${version}`];
  return null;
}

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
