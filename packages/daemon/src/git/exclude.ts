import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../core/log.ts";
import { git } from "./exec.ts";

/** Add a pattern to the repo's info/exclude, once. Git reads that file from the common dir, so one
 * line covers every linked worktree, and it is never committed: how toyon keeps one person's files
 * out of a team's view without touching the team's .gitignore. */
export async function excludeFromGit(cwd: string, pattern: string): Promise<void> {
  const r = await git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  if (!r.ok || !r.out) return log.warn("git", `cannot locate info/exclude for ${cwd}: ${r.err}`);
  const file = r.out;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === pattern)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
}
