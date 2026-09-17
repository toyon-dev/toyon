// The plan as a file. An approval card lives in a transcript that is capped and an ACP session that
// is reaped minutes after it goes idle, so a plan that exists only as a tool-call payload is not
// something a person can come back to, edit, or hand to another worktree. Toyon writes it to the
// worktree instead, where the editor pane reads it rendered like any other markdown and the agent
// can read it back with its own tools.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.ts";
import { excludeFromGit } from "../git/exclude.ts";

/** where a worktree keeps the plan it is working to, relative to its root */
export const PLAN_REL = join(".toyon", "plan.md");

/**
 * Write the plan and keep it out of the diff. Returns the relative path for the card to point at,
 * or null if the worktree would not take it, in which case the card falls back to showing the
 * markdown itself.
 *
 * Excluded by name rather than as `.toyon/`, because `settings.json` beside it is a file a team
 * may well commit.
 */
export async function writePlanDoc(cwd: string, markdown: string): Promise<string | null> {
  try {
    mkdirSync(join(cwd, ".toyon"), { recursive: true });
    writeFileSync(join(cwd, PLAN_REL), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  } catch (e) {
    log.warn(cwd, `could not write ${PLAN_REL}; the plan stays on the card`, e);
    return null;
  }
  await excludeFromGit(cwd, PLAN_REL);
  return PLAN_REL;
}

/**
 * Has the plan on disk moved away from what the agent proposed? A permission answer carries an
 * option id and nothing else, so an edit made in the pane before the yes would otherwise be built
 * by nobody: the agent goes off and implements the version it wrote. Answered against the file
 * every time, since the agent can rewrite it with its own tools too.
 */
export function planEdited(cwd: string, proposed: string): boolean {
  const file = join(cwd, PLAN_REL);
  if (!existsSync(file)) return false;
  try {
    return readFileSync(file, "utf8").trim() !== proposed.trim();
  } catch (e) {
    log.warn(cwd, `could not read ${PLAN_REL}`, e);
    return false;
  }
}
