import { useState } from "react";
import { useFileSync } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { planName, planTitle } from "./planTitle.ts";

/** The title last read for each plan, by worktree and path, for the life of the page. A read is a
 * round trip to the daemon, and the row would otherwise show the file's name for its length on
 * every switch of worktree; the file's name is a number for the plans Toyon writes, so the row read
 * `1` for a beat. A title found once is shown at once, and the re-read moves it only when the
 * heading moved. Keyed by worktree as well as path because most worktrees keep their plan at the
 * same path (`.toyon/plans/1.md`), and the path alone would hand one worktree's title to another. */
const known = new Map<string, string | null>();

/** What a plan row calls the plan, over the composer and in the transcript alike: the file's first
 * heading, read from the disk the way a chip's look reads it, and read again on the signal the open
 * pane follows (the worktree's tree state, pushed after every edit of the agent's), so the title
 * moves with the file the agent keeps editing. The file's name until the first read lands, and when
 * the plan opens with no heading. */
export function usePlanTitle(worktreeId: string | undefined, plan: string | undefined): string {
  const files = useFileSync();
  // the state's number, not the record: the panel's tier landing over the same state changes
  // no file on disk
  const version = useLocalField(worktreeId, "git")?.version;
  const key = worktreeId && plan ? `${worktreeId}\n${plan}` : null;
  const [, landed] = useState(0);
  useOnChange([files, worktreeId, plan, version], () => {
    if (!files || !key || !worktreeId || !plan) return;
    let live = true;
    files.look(worktreeId, plan).then((text) => {
      // a null is no text to show (a dropped socket, a file gone): nothing newer than what is known
      if (!live || text === null) return;
      const title = planTitle(text);
      if (known.has(key) && known.get(key) === title) return;
      known.set(key, title);
      landed((n) => n + 1);
    });
    return () => {
      live = false;
    };
  });
  const title = key ? (known.get(key) ?? null) : null;
  return title ?? (plan ? planName(plan) : "");
}
