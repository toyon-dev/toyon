import type { PickMeta } from "@toyon/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { pickItems } from "../../state/actions/message.ts";
import { useFileSync, useSock, useStore, useUrls } from "../../state/context.tsx";
import { archivedPageOf, localOf } from "../../state/store.ts";
import { IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";
import { useContextMenu } from "../../ui/menu.ts";
import { pickLabel } from "../util.ts";
import { ChipPeek } from "./ChipPeek.tsx";
import { Painted } from "./Painted.tsx";
import { languageOf, paintCode } from "./syntax.ts";

/** a picked element as a chip: crosshair, <Component />, then file:line. Named, not numbered: a
 * component and its file are already a name, and the prompt calls it the same. Its paths are
 * relative to the checkout it was picked in, made so when it was attached. In the composer it can be
 * removed; in the chat it just highlights on hover. Hovered, it shows the source around the line
 * it leads with. The file half is a link wherever there is
 * somewhere to go: a pick keeps pointing at its source long after the message it rode in on. */
export function PickChip({
  pick,
  dir,
  worktreeId,
  tipText,
  onHover,
  onOpen,
  onRemove,
  className = "",
}: {
  pick: PickMeta;
  /** the worktree the paths are read in, for the menu's editors, which want a file on disk */
  dir: string | null;
  /** the worktree whose copy of the source the hover reads */
  worktreeId?: string | null;
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
  // the host the file is on: the daemon's, for the editor rows a path offers
  const { host } = useUrls();
  const chip = useRef<HTMLDivElement | null>(null);
  // a remove unmounts the chip under the pointer, so no mouseleave follows: the hover ends here or
  // the outline it put on the preview stays
  const remove = onRemove
    ? () => {
        onHover?.(false);
        onRemove();
      }
    : undefined;
  return (
    <div
      ref={chip}
      className={cx("pick-chip row row-sm", className)}
      data-tip={tipText}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      {...cm.contextMenu(() => pickItems(pick, { dir, remove, host }))}
    >
      <span className="pick-target">
        <Icon name="pick" className="icon-inline" /> {pickLabel(pick)}
        {lead && (
          <span className="pick-file row-dim">
            {" "}
            · {open(lead.path, lead.line, shown(base(lead.path), lead.line), `Open ${shown(lead.path, lead.line)}`)}
          </span>
        )}
        {behind && (
          <span className="pick-file row-dim">
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
      {remove && <IconButton icon="close" label="Remove attachment" tone="quiet" onClick={remove} />}
      {worktreeId && lead?.line && (
        <ChipPeek chip={chip}>
          <SourcePeek worktreeId={worktreeId} path={lead.path} line={lead.line} />
        </ChipPeek>
      )}
    </div>
  );
}

/** how much of the file the look shows either side of the line the chip names: enough above to
 * say where you are, more below because an element's markup runs down from its opening line */
const PEEK_ABOVE = 6;
const PEEK_BELOW = 16;

/**
 * The source around a picked element's line, read when the look opens: the file as the disk has
 * it now, which is what a press on the link would open. The line is the running page's, counted
 * against the served module, so it waits for the offset that maps it to the file the same way the
 * editor's jump does; nothing shows until both are in, or when the file cannot be read.
 */
function SourcePeek({ worktreeId, path, line }: { worktreeId: string; path: string; line: number }) {
  const files = useFileSync();
  const sock = useSock();
  // an archived worktree serves no page, so its line is the file's and there is no offset to ask for
  const kept = useStore((s) => archivedPageOf(s)?.id === worktreeId);
  const offset = useStore((s) => (kept ? 0 : localOf(s, worktreeId).changedRanges[path]?.offset));
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!kept) sock?.send({ t: "changed-ranges", worktreeId, path });
    files?.look(worktreeId, path).then((t) => {
      if (live) setText(t);
    });
    return () => {
      live = false;
    };
  }, [files, sock, worktreeId, path, kept]);

  const shown = useMemo(() => {
    if (text === null || offset === undefined) return null;
    const lines = text.split("\n");
    const at = line - offset;
    const from = Math.max(1, at - PEEK_ABOVE);
    const to = Math.min(lines.length, at + PEEK_BELOW);
    if (from > to) return null;
    const slice = lines.slice(from - 1, to);
    return { from, at, slice, painted: paintCode(slice.join("\n"), languageOf("", path)) };
  }, [text, offset, line, path]);

  if (!shown) return null;
  const width = String(shown.from + shown.slice.length - 1).length;
  return (
    <pre className="pick-peek">
      {shown.slice.map((raw, i) => {
        const n = shown.from + i;
        const pieces = shown.painted[i];
        return (
          <span key={n} className="pick-peek-line" data-state={n === shown.at ? "current" : undefined}>
            <span className="pick-peek-n">{String(n).padStart(width)}</span>
            {pieces?.length ? <Painted pieces={pieces} /> : raw || " "}
          </span>
        );
      })}
    </pre>
  );
}
