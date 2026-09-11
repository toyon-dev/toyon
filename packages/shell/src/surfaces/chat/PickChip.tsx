import type { PickMeta } from "@toyon/shared";
import { pickItems } from "../../state/actions/message.ts";
import { IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";
import { useContextMenu } from "../../ui/menu.ts";
import { pickLabel } from "../util.ts";

/** a picked element as a chip: crosshair, <Component />, then file:line. Named, not numbered: a
 * component and its file are already a name, and the prompt calls it the same. Its paths are
 * relative to the checkout it was picked in, made so when it was attached. In the composer it can be
 * removed; in the chat it just highlights on hover. The file half is a link wherever there is
 * somewhere to go: a pick keeps pointing at its source long after the message it rode in on. */
export function PickChip({
  pick,
  dir,
  tipText,
  onHover,
  onOpen,
  onRemove,
  className = "",
}: {
  pick: PickMeta;
  /** the worktree the paths are read in, for the menu's editors, which want a file on disk */
  dir: string | null;
  tipText?: string;
  onHover?: (entering: boolean) => void;
  /** open the source this element was rendered from, at the line the chip names */
  onOpen?: (path: string, line: number) => void;
  onRemove?: () => void;
  className?: string;
}) {
  // the call site leads, because it is the file the pick is usually about: picking a control finds
  // the shared component it is made of, and the line worth reading is the one that writes it. The
  // component's own JSX keeps a link of its own. Both are named by basename, since the number and the
  // component already fill most of a dock-wide row; the whole path is the link's tooltip.
  const call = pick.callFile;
  const src = pick.file;
  const lead = call ? { path: call, line: pick.callLine } : src ? { path: src, line: pick.line } : null;
  const behind = call && src ? { path: src, line: pick.line } : null;
  const shown = (path: string, line: number | null) => `${path}${line ? `:${line}` : ""}`;
  const base = (path: string) => path.split("/").pop() ?? path;
  const open = (path: string, line: number | null, label: string, tip: string) =>
    onOpen ? (
      <button className="pick-open" data-tip={tip} onClick={() => onOpen(path, line ?? 1)}>
        {label}
      </button>
    ) : (
      label
    );
  const cm = useContextMenu("chat");
  return (
    <div
      className={cx("pick-chip", className)}
      data-tip={tipText}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      {...cm.contextMenu(() => pickItems(pick, { dir, remove: onRemove }))}
    >
      <span className="pick-target">
        <Icon name="pick" className="icon-inline" /> {pickLabel(pick)}
        {lead && (
          <span className="pick-file">
            {" "}
            · {open(lead.path, lead.line, shown(base(lead.path), lead.line), `Open ${shown(lead.path, lead.line)}`)}
          </span>
        )}
        {behind && (
          <span className="pick-file">
            {" "}
            ·{" "}
            {open(
              behind.path,
              behind.line,
              shown(behind.path.split("/").pop() ?? behind.path, behind.line),
              `Open the component: ${shown(behind.path, behind.line)}`,
            )}
          </span>
        )}
      </span>
      {onRemove && <IconButton icon="close" label="Remove attachment" tone="quiet" onClick={onRemove} />}
    </div>
  );
}
