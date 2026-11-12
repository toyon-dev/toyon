// A worktree named on a row Toyon draws (a handoff row, the plan's worktrees section, the line
// under the box, a sibling's landing), as the mention a message draws it: the chip with the row's
// dot and tip, a press opening the row, an archived one its page. One drawing for every place a
// worktree is named, so the agent's prose, the person's mentions and Toyon's own rows agree on
// what a worktree looks like. Toyon names a worktree by id, so the chip reaches one in another
// project too, and the press switches to that project. A worktree that is gone from both lists is
// named in plain words, since there is nothing to open.

import { useMemo } from "react";
import { linkOpener } from "../../state/actions/message.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { archivedById, worktreeById } from "../../state/store.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { mentionTip } from "./mentions.ts";
import { siblingOf } from "./siblings.ts";

/** `inert`: the chip is the label of a control (a fate button naming where a piece goes), so a
 * press is the control's and the chip opens nothing of its own */
export function WorktreeChip({ id, title, inert }: { id: string; title?: string; inert?: boolean }) {
  const sock = useSock();
  const dispatch = useDispatch();
  const shipping = useStore((s) => s.shipping);
  // read from every project's rows and not the rail's: the row a piece came from or went to may
  // be another project's. One whose remove is in flight is the archive's already.
  const row = useStore((s) => (s.archiving.includes(id) ? null : worktreeById(s, id)));
  // the archive's record, read only once the row is gone: the lists are stable until they change
  const archived = useStore((s) => (row ? null : archivedById(s, id)));
  const live = useMemo(() => (row ? siblingOf(row, shipping) : null), [row, shipping]);
  const branch = live?.branch ?? archived?.branch;
  if (!branch) return <span>{title ?? id}</span>;
  // the mark reads as the rail's row does, by title; the branch is the tip's and the right-click's
  const t = mentionTip(live ?? { id, title: archived?.title ?? title ?? branch, archived: true, branch });
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
      @{t.text}
      {t.dot && (
        <span className="chat-mention-dot">
          <span className={`dot ${t.dot}`} />
        </span>
      )}
    </span>
  );
}
