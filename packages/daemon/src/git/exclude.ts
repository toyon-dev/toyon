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

/** Replace a named block of patterns in info/exclude, or drop the block when `patterns` is empty.
 * A block rather than a line each, because these are somebody else's rules copied from elsewhere:
 * they arrive together, they are rewritten together when that file changes, and they all go the
 * moment git has the real thing. Rewrites nothing when the block already reads this way, so a
 * worktree create does not touch the file every time. */
export async function excludeBlock(cwd: string, name: string, patterns: string[]): Promise<void> {
  const file = await excludeFile(cwd);
  if (!file) return;
  const open = `# toyon ${name}`;
  const close = `# toyon end ${name}`;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = current.split("\n");
  const from = lines.indexOf(open);
  const to = lines.indexOf(close);
  const kept = from >= 0 && to > from ? [...lines.slice(0, from), ...lines.slice(to + 1)] : lines;
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const next = [...kept, ...(patterns.length > 0 ? [open, ...patterns, close] : [])];
  const text = next.length > 0 ? `${next.join("\n")}\n` : "";
  if (text === current) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
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
