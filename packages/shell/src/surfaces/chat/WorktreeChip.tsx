// A worktree of the project named on a row Toyon draws (a split row, the plan's worktrees
// section, the line under the box, a sibling's landing), as the mention a message draws it: the
// chip with the row's dot and tip, a press opening the row, an archived one its page. One drawing
// for every place a worktree is named, so the agent's prose, the person's mentions and Toyon's
// own rows agree on what a worktree looks like. A worktree that is gone from both lists is named
// in plain words, since there is nothing to open.

import { useMemo } from "react";
import { linkOpener } from "../../state/actions/message.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { worktreeById } from "../../state/store.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { mentionTip } from "./mentions.ts";
import { siblingWorktrees } from "./siblings.ts";

/** `inert`: the chip is the label of a control (a fate button naming where a piece goes), so a
 * press is the control's and the chip opens nothing of its own */
export function WorktreeChip({ id, title, inert }: { id: string; title?: string; inert?: boolean }) {
  const sock = useSock();
  const dispatch = useDispatch();
  const rows = useStore((s) => s.visible);
  const row = useStore((s) => worktreeById(s, id));
  // the archive's record, read only once the row is gone: the lists are stable until they change
  const archived = useStore((s) =>
    row
      ? null
      : (Object.values(s.archived)
          .flat()
          .find((a) => a.id === id) ?? null),
  );
  const live = useMemo(
    () => (row ? (siblingWorktrees(rows, row.worktree.repoId, null).find((w) => w.id === id) ?? null) : null),
    [rows, row, id],
  );
  const branch = live?.branch ?? archived?.branch;
  if (!branch) return <span>{title ?? id}</span>;
  const t = mentionTip(live ?? { id, title: archived?.title ?? title ?? branch, archived: true });
  const rowTip = tip(t.text, undefined, { placement: "follow", dot: t.dot, detail: t.detail });
  const open = linkOpener({ kind: "worktree", id, branch, archived: !live }, null, { sock, dispatch });
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the chip is the mention a message draws, and the row around it carries the keyboard
    <span
      className="chat-mention"
      data-worktree={id}
      data-branch={branch}
      data-archived={live ? undefined : ""}
      {...rowTip}
      onClick={
        inert
          ? undefined
          : (e) => {
              // the log routes a press on a mention too; one open is enough
              e.stopPropagation();
              open?.();
            }
      }
    >
      {t.dot && <span className={`dot ${t.dot}`} />}@{branch}
    </span>
  );
}
