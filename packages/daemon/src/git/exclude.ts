import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../core/log.ts";
import { git } from "./exec.ts";

/** the repo's info/exclude. Git reads it from the common dir, so one line covers every linked
 * worktree, and it is never committed: how toyon keeps one person's files out of a team's view
 * without touching the team's .gitignore. */
async function excludeFile(cwd: string): Promise<string | null> {
  const r = await git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  if (r.ok && r.out) return r.out;
  log.warn("git", `cannot locate info/exclude for ${cwd}: ${r.err}`);
  return null;
}

/** add a pattern to the repo's info/exclude, once */
export async function excludeFromGit(cwd: string, pattern: string): Promise<void> {
  const file = await excludeFile(cwd);
  if (!file) return;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === pattern)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
}

/** take a pattern back out of info/exclude: the file is gone, or is about to be the one git sees */
export async function unexcludeFromGit(cwd: string, pattern: string): Promise<void> {
  const file = await excludeFile(cwd);
  if (!file || !existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n");
  const kept = lines.filter((l) => l.trim() !== pattern);
  if (kept.length === lines.length) return;
  writeFileSync(file, kept.join("\n"));
}
