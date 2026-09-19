// The plan as a file. An approval card lives in a transcript that is capped and an ACP session that
// is reaped minutes after it goes idle, so a plan that exists only as a tool-call payload is not
// something a person can come back to, edit, or hand to another worktree. Toyon writes it to the
// worktree instead, where the editor pane reads it rendered like any other markdown and the agent
// can read it back with its own tools.
//
// One file per round, never overwritten: a rejected plan comes back revised as a new card, and the
// person may have edited the first in the pane, so each card names a file of its own and the
// folder is what the archive carries beside the chat.

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

/** one past the highest number in the folder, so a deleted plan's number is never given again */
function nextNumber(dir: string): number {
  if (!existsSync(dir)) return 1;
  let max = 0;
  for (const name of readdirSync(dir)) {
    const n = Number(PLAN_NAME.exec(name)?.[1]);
    if (n > max) max = n;
  }
  return max + 1;
}

/**
 * Write the plan as the next numbered file and keep the folder out of the diff. Returns the
 * relative path for the card to point at, or null if the worktree would not take it, in which
 * case the card falls back to showing the markdown itself.
 *
 * Excluded as the folder rather than `.toyon/`, because `settings.json` beside it is a file a team
 * may well commit.
 */
export async function writePlanDoc(cwd: string, markdown: string): Promise<string | null> {
  const dir = join(cwd, PLANS_DIR);
  const rel = join(PLANS_DIR, `${nextNumber(dir)}.md`);
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
