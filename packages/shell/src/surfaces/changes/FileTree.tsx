import type { GitFileStatus } from "@toyon/shared";
import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  memo,
  type RefObject,
  useCallback,
  useMemo,
  useState,
} from "react";
import { previewBus } from "../../app/previewBus.ts";
import { listFiles, openFile } from "../../state/actions/file.ts";
import { treeItems, treeSpaceItems } from "../../state/actions/fileTree.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { readingView } from "../../state/store.ts";
import { cx } from "../../ui/cx.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { jumpTo, step } from "../../ui/listNav.ts";
import { type MenuEntry, useContextMenu } from "../../ui/menu.ts";
import { rowState } from "../../ui/rowState.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { endPathDrag, PATH_MIME, startPathDrag } from "../chat/useIntake.ts";
import { ancestors, xyClass, xyLetter } from "../util.ts";
import { buildTree, marks, type TreeRow, visibleRows } from "./fileTree.ts";
import "./tree.css";

const NO_PATHS: string[] = [];
const NO_STATUS: GitFileStatus[] = [];
const NO_FOLDERS: ReadonlySet<string> = new Set();
/** what the tree points `aria-activedescendant` at; the rows are not focusable */
const treeRowId = (i: number) => `tree-row-${i}`;

/**
 * The files tab: every file in the worktree, for reading and for pointing the agent at. A row opens
 * the file in the editor pane, names it in the chat, or is dragged there; the tree never adds,
 * renames or deletes anything (its menu asks the agent to).
 *
 * Folders are open for one of two reasons. The person opened them, which the store remembers per
 * worktree (`treeOpen`). Or the file in the editor sits inside them, which lasts while that file is
 * open and is the tree's own, so a few jumps with ⌘P do not leave the whole tree open. Closing a
 * folder closes it for both.
 */
export function FileTree({
  worktreeId,
  dir,
  openPath,
  openRef,
  rootRef,
}: {
  worktreeId: string;
  /** the checkout on disk, for the paths the menu copies and opens */
  dir: string;
  /** the file open in the editor, when it is this worktree's */
  openPath: string | null;
  /** the commit that file was opened at; a file at a commit may not exist in the tree */
  openRef: string | null;
  rootRef: RefObject<HTMLDivElement>;
}) {
  const store = useStoreInstance();
  const sock = useSock();
  const dispatch = useDispatch();
  const files = useLocalField(worktreeId, "files");
  const submodules = useLocalField(worktreeId, "submodules");
  const git = useLocalField(worktreeId, "git");
  const status = git?.files ?? NO_STATUS;

  // Listed when the tab opens, and again on each status, which listFiles turns into a request
  // only when the set of files can have changed: git-status arrives after every tool call, and an
  // edit to a file that exists changes nothing here.
  useOnChange([worktreeId, git, sock], () => listFiles(worktreeId, store.getState(), { sock, dispatch }));

  const openList = useStore((s) => s.treeOpen[worktreeId] ?? NO_PATHS);
  const open = useMemo(() => new Set(openList), [openList]);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(NO_FOLDERS);
  useOnChange([worktreeId, openPath, openRef], () =>
    setRevealed(openPath && !openRef ? new Set(ancestors(openPath).filter((a) => !open.has(a))) : NO_FOLDERS),
  );
  const isOpen = useCallback((path: string) => open.has(path) || revealed.has(path), [open, revealed]);
  const toggle = useCallback(
    (path: string) => {
      const shut = open.has(path) || revealed.has(path);
      if (shut && revealed.has(path)) {
        const kept = new Set(revealed);
        kept.delete(path);
        setRevealed(kept);
      }
      dispatch({ a: "tree-folder", worktreeId, path, open: !shut });
    },
    [open, revealed, worktreeId, dispatch],
  );

  const tree = useMemo(() => buildTree(files ?? NO_PATHS, submodules ?? NO_PATHS), [files, submodules]);
  const rows = useMemo(() => visibleRows(tree, isOpen), [tree, isOpen]);
  const marked = useMemo(() => marks(status), [status]);

  // The cursor is a path, since a working agent keeps adding rows above it. When its row is gone
  // (a folder over it closed), it stands on the nearest folder still showing.
  const [cursor, setCursor] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  useOnChange([worktreeId], () => setCursor(null));
  const sel = useMemo(() => {
    if (cursor === null) return -1;
    const at = rows.findIndex((r) => r.path === cursor);
    if (at >= 0) return at;
    for (const a of ancestors(cursor).reverse()) {
      const i = rows.findIndex((r) => r.path === a);
      if (i >= 0) return i;
    }
    return -1;
  }, [rows, cursor]);
  useOnChange([sel, focused], () => {
    if (focused)
      rootRef.current?.querySelector<HTMLElement>('[data-state~="cursor"]')?.scrollIntoView({ block: "nearest" });
  });

  // the file itself, as ⌘P opens it: the tree is not a list of changes, so no diff first
  const openAt = useCallback(
    (path: string, focus: boolean) =>
      openFile({ sock, dispatch }, { worktreeId, path, view: readingView(path), focus }),
    [worktreeId, sock, dispatch],
  );
  const press = useCallback(
    (row: TreeRow) => {
      setCursor(row.path);
      if (row.kind === "folder") toggle(row.path);
      else if (row.kind === "file") openAt(row.path, false);
    },
    [toggle, openAt],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const r = rows[sel];
    const go = (i: number) => {
      const to = rows[i];
      if (!to) return;
      setCursor(to.path);
      // the arrows preview, as they do in the changes list: the file shows while the keyboard
      // stays here, and Enter is what takes it into the pane. A folder shows nothing.
      if (to.kind === "file") openAt(to.path, false);
    };
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        go(sel < 0 ? 0 : step(sel, e.key === "ArrowDown" ? 1 : -1, rows.length));
        return;
      // before the typeahead below, which would take Space as a letter
      case " ":
        e.preventDefault();
        if (r?.kind === "file") openAt(r.path, false);
        else if (r?.kind === "folder") toggle(r.path);
        return;
      case "Enter":
        e.preventDefault();
        if (r?.kind === "file") openAt(r.path, true);
        else if (r?.kind === "folder") toggle(r.path);
        return;
      case "ArrowRight":
        e.preventDefault();
        if (r?.kind !== "folder") return;
        if (!r.open) toggle(r.path);
        else if ((rows[sel + 1]?.depth ?? -1) > r.depth) go(sel + 1);
        return;
      case "ArrowLeft": {
        e.preventDefault();
        if (!r) return;
        if (r.kind === "folder" && r.open) {
          toggle(r.path);
          return;
        }
        // a top-level row has nowhere to climb to, so a held ← stays put rather than leaving the tab
        const parent = ancestors(r.path).at(-1);
        if (parent !== undefined) setCursor(parent);
        return;
      }
      case "Escape":
        // as in the changes list: close what the tree opened, then hand the keyboard back
        e.stopPropagation();
        if (openPath !== null) dispatch({ a: "close-editor" });
        else (document.activeElement as HTMLElement | null)?.blur();
        return;
    }
    if (e.key.length === 1) {
      const i = jumpTo(
        rows.map((x) => x.name),
        sel,
        e.key,
      );
      if (i >= 0) {
        e.preventDefault();
        go(i);
      }
    }
  };

  const cm = useContextMenu("tree");
  const menuFor = useCallback(
    (row: TreeRow): MenuEntry[] =>
      treeItems({ worktreeId, dir, path: row.path, folder: row.kind !== "file" }, store, { sock, dispatch }),
    [worktreeId, dir, store, sock, dispatch],
  );
  const hover = useCallback(
    (row: TreeRow, entering: boolean) => {
      if (row.kind !== "file") return;
      // no ranges: the file is not a change here, so everything it draws lights up
      previewBus.post(
        worktreeId,
        entering ? { type: "highlight-file", path: row.path, ranges: null } : { type: "highlight-clear" },
      );
    },
    [worktreeId],
  );
  const dragStart = useCallback(
    (row: TreeRow, e: DragEvent) => {
      e.dataTransfer.setData(PATH_MIME, row.path);
      // anywhere outside toyon takes the path as text
      e.dataTransfer.setData("text/plain", row.path);
      e.dataTransfer.effectAllowed = "copy";
      startPathDrag({ worktreeId, path: row.path, folder: row.kind !== "file" });
    },
    [worktreeId],
  );
  const dragEnd = useCallback(() => endPathDrag(store), [store]);

  return (
    <div
      className="tree"
      role="tree"
      aria-label="files"
      // the tree holds the keyboard and no row can take focus, so a reader is told where the cursor
      // is by the tree pointing at that row rather than by focus moving to it
      aria-activedescendant={focused && sel >= 0 ? treeRowId(sel) : undefined}
      tabIndex={0}
      ref={rootRef}
      onKeyDown={onKeyDown}
      onFocus={() => {
        setFocused(true);
        // the keyboard arriving picks up at the file in the editor, or the top
        if (sel < 0) setCursor(openPath && rows.some((r) => r.path === openPath) ? openPath : (rows[0]?.path ?? null));
      }}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
      // the row under a press becomes the cursor before the focus lands, so the mark never lights a
      // row the press did not hit. No preventDefault: it would cancel the drag a press may start.
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
        if (hit?.dataset.path !== undefined) setCursor(hit.dataset.path);
      }}
      {...cm.contextMenu((from) => {
        const r = rows[sel];
        return from === "keyboard" && r ? menuFor(r) : treeSpaceItems({ worktreeId, dir }, { sock, dispatch });
      })}
    >
      {files === undefined ? (
        <div className="empty">listing files…</div>
      ) : rows.length === 0 ? (
        <div className="empty">no files</div>
      ) : (
        rows.map((row, i) => (
          <TreeItem
            key={row.path}
            row={row}
            id={treeRowId(i)}
            status={marked.files.get(row.path)}
            changedInside={row.kind !== "file" && marked.folders.has(row.path)}
            current={focused ? i === sel : !openRef && row.path === openPath}
            cursor={focused && i === sel}
            onPress={press}
            menu={menuFor}
            onHover={hover}
            onDragStart={dragStart}
            onDragEnd={dragEnd}
          />
        ))
      )}
    </div>
  );
}

const TreeItem = memo(function TreeItem({
  row,
  id,
  status,
  changedInside,
  current,
  cursor,
  onPress,
  menu,
  onHover,
  onDragStart,
  onDragEnd,
}: {
  row: TreeRow;
  id: string;
  status: GitFileStatus | undefined;
  changedInside: boolean;
  /** the row the tree marks: the cursor while the tree has the keyboard, the open file otherwise */
  current: boolean;
  cursor: boolean;
  onPress: (row: TreeRow) => void;
  menu: (row: TreeRow) => MenuEntry[];
  onHover: (row: TreeRow, entering: boolean) => void;
  onDragStart: (row: TreeRow, e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const cm = useContextMenu("tree");
  const submodule = row.kind === "submodule";
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tree takes the keyboard for every row, as a listbox does
    // biome-ignore lint/a11y/useFocusableInteractive: the tree holds focus and moves its cursor over the rows
    <div
      role="treeitem"
      id={id}
      aria-level={row.depth + 1}
      aria-expanded={row.kind === "folder" ? row.open : undefined}
      aria-selected={cursor}
      // a div, not a button: Firefox never starts a drag on a button
      className="row row-sm tree-row row-edge"
      data-state={rowState({ current, cursor })}
      data-kind={row.kind}
      data-path={row.path}
      style={{ "--tree-depth": row.depth } as CSSProperties}
      draggable={!submodule}
      onDragStart={(e) => onDragStart(row, e)}
      onDragEnd={onDragEnd}
      onClick={() => onPress(row)}
      onMouseEnter={() => onHover(row, true)}
      onMouseLeave={() => onHover(row, false)}
      {...cm.contextMenu(() => menu(row))}
      {...(submodule ? tip("A submodule: its files belong to its own repository") : {})}
    >
      <span className="tree-caret row-dim">
        {row.kind === "folder" && <Icon name="caret" className={cx("icon-inline disc-caret", !row.open && "shut")} />}
      </span>
      <span className={cx("tree-name", submodule && "row-dim")}>{row.name}</span>
      {status ? (
        <span className={`xy ${xyClass(status.xy)}`}>{xyLetter(status.xy)}</span>
      ) : (
        changedInside && <span className="dot tree-changed" />
      )}
    </div>
  );
});
