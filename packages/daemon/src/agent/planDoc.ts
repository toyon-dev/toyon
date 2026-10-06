// The plan as a file. An approval card lives in a transcript that is capped and an ACP session that
// is reaped minutes after it goes idle, so a plan that exists only as a tool-call payload is not
// something a person can come back to, edit, or hand to another worktree. Toyon writes it to the
// worktree instead, where the editor pane reads it rendered like any other markdown and the agent
// can read it back with its own tools.
//
// One file per revision, never overwritten: a rejected plan comes back revised as a new card, and
// the person may have edited the first in the pane, so each card names a file of its own and the
// folder is what the archive carries beside the chat. An agent answering a question in plan mode
// re-submits its plan unchanged, though, and that card names the file already there: a number
// that ticks is a plan that moved, not a count of how many times the card was drawn.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.ts";
import { excludeFromGit } from "../git/exclude.ts";

/** where a worktree keeps the plans it was shown, relative to its root */
export const PLANS_DIR = join(".toyon", "plans");

const PLAN_NAME = /^(\d+)\.md$/;

/** a plan's worktree-relative path, and nothing else: the archive reads a path a client sent */
export function isPlanPath(rel: string): boolean {
  return rel.startsWith(`${PLANS_DIR}/`) && PLAN_NAME.test(rel.slice(PLANS_DIR.length + 1));
}

/** the highest number in the folder, 0 for none; a deleted plan's number is never given again */
function lastNumber(dir: string): number {
  if (!existsSync(dir)) return 0;
  let max = 0;
  for (const name of readdirSync(dir)) {
    const n = Number(PLAN_NAME.exec(name)?.[1]);
    if (n > max) max = n;
  }
  return max;
}

/** does the newest plan already say this? Judged against the file as it is now, so one the person
 * edited in the pane no longer matches and the unchanged proposal gets a file of its own again */
function sameAsLast(cwd: string, rel: string, markdown: string): boolean {
  try {
    return readFileSync(join(cwd, rel), "utf8").trim() === markdown.trim();
  } catch (e) {
    log.warn(cwd, `could not read ${rel}`, e);
    return false;
  }
}

/**
 * Write the plan as the next numbered file and keep the folder out of the diff, or name the newest
 * file when it already holds this plan. Returns the relative path for the card to point at, or
 * null if the worktree would not take it, in which case the card falls back to showing the
 * markdown itself.
 *
 * Excluded as the folder rather than `.toyon/`, because `settings.json` beside it is a file a team
 * may well commit.
 */
export async function writePlanDoc(cwd: string, markdown: string): Promise<string | null> {
  const dir = join(cwd, PLANS_DIR);
  const last = lastNumber(dir);
  if (last > 0) {
    const newest = join(PLANS_DIR, `${last}.md`);
    if (sameAsLast(cwd, newest, markdown)) return newest;
  }
  const rel = join(PLANS_DIR, `${last + 1}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(cwd, rel), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  } catch (e) {
    log.warn(cwd, `could not write ${rel}; the plan stays on the card`, e);
    return null;
  }
  await excludeFromGit(cwd, `${PLANS_DIR}/`);
  return rel;
}

/**
 * Has the plan on disk moved away from what the agent proposed? A permission answer carries an
 * option id and nothing else, so an edit made in the pane before the yes would otherwise be built
 * by nobody: the agent goes off and implements the version it wrote. Answered against the file
 * every time, since the agent can rewrite it with its own tools too.
 */
export function planEdited(cwd: string, rel: string, proposed: string): boolean {
  const file = join(cwd, rel);
  if (!existsSync(file)) return false;
  try {
    return readFileSync(file, "utf8").trim() !== proposed.trim();
  } catch (e) {
    log.warn(cwd, `could not read ${rel}`, e);
    return false;
  }
}
