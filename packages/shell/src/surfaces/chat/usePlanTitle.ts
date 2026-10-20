import { useState } from "react";
import { useFileSync } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { planName, planTitle } from "./planTitle.ts";

/** What a plan row calls the plan, over the composer and in the transcript alike: the file's first
 * heading, read from the disk the way a chip's look reads it, and read again on the signal the open
 * pane follows (the worktree's tree state, pushed after every edit of the agent's), so the title
 * moves with the file the agent keeps editing. The file's name until the read lands, and when the
 * plan opens with no heading. A title belongs to the file it was read from, so a new plan never
 * wears the old one's. */
export function usePlanTitle(worktreeId: string | undefined, plan: string | undefined): string {
  const files = useFileSync();
  // the state's number, not the record: the panel's tier landing over the same state changes
  // no file on disk
  const version = useLocalField(worktreeId, "git")?.version;
  const [named, setNamed] = useState<{ plan: string; title: string | null } | null>(null);
  useOnChange([files, worktreeId, plan, version], () => {
    if (!files || !worktreeId || !plan) return;
    let live = true;
    files.look(worktreeId, plan).then((text) => {
      if (live) setNamed({ plan, title: text ? planTitle(text) : null });
    });
    return () => {
      live = false;
    };
  });
  const title = named && named.plan === plan ? named.title : null;
  return title ?? (plan ? planName(plan) : "");
}
