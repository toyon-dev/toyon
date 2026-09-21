import type { GitFileStatus } from "@toyon/shared";
import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { previewBus } from "../../app/previewBus.ts";
import { createFile, listFiles, openFile } from "../../state/actions/file.ts";
import { treeItems, treeSpaceItems } from "../../state/actions/fileTree.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { readingView } from "../../state/store.ts";
import { cx } from "../../ui/cx.ts";
import { Field } from "../../ui/Field.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { jumpTo, step } from "../../ui/listNav.ts";
import { type MenuEntry, useContextMenu } from "../../ui/menu.ts";
import { rowState } from "../../ui/rowState.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { endPathDrag, PATH_MIME, startPathDrag } from "../chat/useIntake.ts";
import { ancestors, xyClass, xyLetter } from "../util.ts";
import { buildTree, marks, newFilePath, parentOf, type TreeRow, visibleRows } from "./fileTree.ts";
import "./tree.css";

const NO_PATHS: string[] = [];
const NO_STATUS: GitFileStatus[] = [];
const NO_FOLDERS: ReadonlySet<string> = new Set();
/** what the tree points `aria-activedescendant` at; the rows are not focusable */
const treeRowId = (i: number) => `tree-row-${i}`;

/**
 * The files tab: every file in the worktree, for reading and for pointing the agent at. A row opens
 * the file in the editor pane, names it in the chat, or is dragged there. The tree makes an empty
 * file itself, named in a row; renaming and deleting are the agent's (its menu asks it to).
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
  const ignored = useLocalField(worktreeId, "ignored");
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

  const tree = useMemo(
    () => buildTree(files ?? NO_PATHS, submodules ?? NO_PATHS, ignored ?? NO_PATHS),
    [files, submodules, ignored],
  );
  const rows = useMemo(() => visibleRows(tree, isOpen), [tree, isOpen]);
  const marked = useMemo(() => marks(status), [status]);

  // The cursor is a path, since a working agent keeps adding rows above it. When its row is gone
  // (a folder over it closed), it stands on the nearest folder still showing.
  // A folder a chat link opened: the store has opened the folders over it, so its row shows, and
  // the cursor starts there. Set during render rather than in an effect, since the keyboard is on
  // its way to the tree from the same action and an effect would land after the focus that reads
  // the cursor. A new worktree starts with none.
  const reveal = useStore((s) => s.treeReveal);
  const linked = reveal && reveal.worktreeId === worktreeId ? reveal : null;
  const [cursor, setCursor] = useState<string | null>(() => linked?.path ?? null);
  const [seen, setSeen] = useState({ worktreeId, linked });
  if (seen.worktreeId !== worktreeId || seen.linked !== linked) {
    setSeen({ worktreeId, linked });
    setCursor(linked?.path ?? null);
  }
  const [focused, setFocused] = useState(false);
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

  // The row a new file is named in, under its folder's row (at the top, for the root). The tree's
  // own state, since nothing else reads it. `attempt` tells a write's late answer from a row that
  // was closed or reopened while it was out, so it never lands its error on the wrong one.
  const [making, setMaking] = useState<{ dir: string; error: string | null; busy: boolean } | null>(null);
  const attempt = useRef(0);
  const beginNew = useCallback(
    (inDir: string) => {
      if (inDir && !isOpen(inDir)) toggle(inDir);
      attempt.current++;
      setMaking({ dir: inDir, error: null, busy: false });
    },
    [isOpen, toggle],
  );
  const cancelNew = useCallback(() => {
    attempt.current++;
    setMaking(null);
  }, []);
  const submitNew = useCallback(
    (typed: string) => {
      if (!making || making.busy) return;
      const at = newFilePath(making.dir, typed);
      if ("error" in at) {
        setMaking({ ...making, error: at.error });
        return;
      }
      const mine = ++attempt.current;
      setMaking({ ...making, error: null, busy: true });
      createFile({ sock, dispatch }, { worktreeId, path: at.path }).then((error) => {
        // the file is open in the pane by now, which took the keyboard and closed this row
        if (error === null) setCursor(at.path);
        if (mine !== attempt.current) return;
        setMaking(error === null ? null : { ...making, error, busy: false });
      });
    },
    [making, worktreeId, sock, dispatch],
  );

  const cm = useContextMenu("tree");
  const menuFor = useCallback(
    (row: TreeRow): MenuEntry[] =>
      treeItems(
        {
          worktreeId,
          dir,
          path: row.path,
          folder: row.kind !== "file",
          // a submodule's files are another repository's, so a file made from its row sits beside it
          newIn: row.kind === "folder" || row.kind === "ignored" ? row.path : parentOf(row.path),
        },
        store,
        { sock, dispatch },
        beginNew,
      ),
    [worktreeId, dir, store, sock, dispatch, beginNew],
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
        // the keyboard arriving with no cursor picks up at the file in the editor, or the top. A
        // cursor whose row is not showing is kept: a chat link's folder is the cursor before the
        // listing that holds it lands, and a row that closed over it stands in through `sel`.
        if (cursor === null) {
          setCursor(openPath && rows.some((r) => r.path === openPath) ? openPath : (rows[0]?.path ?? null));
        }
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
        return from === "keyboard" && r
          ? menuFor(r)
          : treeSpaceItems({ worktreeId, dir }, store, { sock, dispatch }, beginNew);
      })}
    >
      {files === undefined ? (
        <div className="empty">listing files…</div>
      ) : rows.length === 0 && !making ? (
        <div className="empty">no files</div>
      ) : (
        withNewRow(
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
          )),
          making &&
            (() => {
              const at = making.dir === "" ? -1 : rows.findIndex((r) => r.path === making.dir);
              return {
                at,
                node: (
                  <NewFileRow
                    key="new-file"
                    depth={at >= 0 ? (rows[at]?.depth ?? 0) + 1 : 0}
                    error={making.error}
                    onSubmit={submitNew}
                    onCancel={cancelNew}
                  />
                ),
              };
            })(),
        )
      )}
    </div>
  );
}

/** the rows with the naming row slotted in after its folder's row: index -1 puts it first */
function withNewRow(items: ReactNode[], add: { at: number; node: ReactNode } | null): ReactNode[] {
  if (!add) return items;
  return [...items.slice(0, add.at + 1), add.node, ...items.slice(add.at + 1)];
}

/**
 * The row a new file is named in: a file row at its folder's depth whose name is a field, with why
 * the name was not taken under it. The keys stay in the field, since the tree's typeahead and
 * arrows would read them, and Escape closes this row rather than climbing the ladder. Leaving the
 * field closes the row as well: a name half typed is nothing to keep.
 */
function NewFileRow({
  depth,
  error,
  onSubmit,
  onCancel,
}: {
  depth: number;
  error: string | null;
  onSubmit: (typed: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const indent = { "--tree-depth": depth } as CSSProperties;
  // a root file's caret column is a stub (tree.css); the rows here carry no level, so they say root
  const root = depth === 0 || undefined;
  return (
    <>
      {/* no treeitem role: the field is what the keyboard is in, and the row only seats it */}
      <div className="row row-sm tree-row" data-kind="file" data-root={root} style={indent}>
        <span className="tree-caret row-dim" />
        <Field
          bare
          font="mono"
          autoFocus
          className="tree-new-name"
          aria-label="new file name"
          aria-invalid={error !== null || undefined}
          placeholder="name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit(typed);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={onCancel}
        />
      </div>
      {error && (
        <div className="tree-row tree-new-error" data-root={root} style={indent}>
          <span className="tree-caret" />
          <span className="hint">{error}</span>
        </div>
      )}
    </>
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
  // what opens as nothing says why on hover; an ignored file needs no word, it opens as any file
  const why = submodule
    ? "A submodule: its files belong to its own repository"
    : row.kind === "ignored"
      ? "Ignored by git, so what is inside is not listed"
      : null;
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
      {...(why ? tip(why) : {})}
    >
      <span className="tree-caret row-dim">
        {row.kind === "folder" && <Icon name="caret" className={cx("icon-inline disc-caret", !row.open && "shut")} />}
      </span>
      <span className={cx("tree-name", (submodule || row.ignored) && "row-dim")}>{row.name}</span>
      {status ? (
        <span className={`xy ${xyClass(status.xy)}`}>{xyLetter(status.xy)}</span>
      ) : (
        changedInside && <span className="dot tree-changed" />
      )}
    </div>
  );
});
