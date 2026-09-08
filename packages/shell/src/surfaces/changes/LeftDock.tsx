import type { GitFileStatus } from "@toyon/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useSock, useStore } from "../../state/context.tsx";
import { useActive, useActiveId, useLocalField } from "../../state/selectors.ts";
import { step } from "../../ui/listNav.ts";
import { editorItems, Menu } from "../../ui/Menu.tsx";
import { shiftRanges, wtDir } from "../util.ts";
import { CommitBox } from "./CommitBox.tsx";
import { GitFileRow } from "./GitFileRow.tsx";

/** one array, so a worktree the daemon has not reported on yet does not hand the row list a fresh
 * identity on every render and re-render every row with it */
const NO_FILES: GitFileStatus[] = [];

/** the changes panel: uncommitted + committed-not-landed files over a commit box */
export function LeftDock({ width }: { width: number }) {
  const sock = useSock();
  const activeId = useActiveId();
  const active = useActive();
  const leftOpen = useStore((s) => s.leftOpen);
  const focusReq = useStore((s) => s.focusLeft);
  const gitInfo = useLocalField(activeId, "git");
  // the row whose diff is open in the editor; a plain string so the selector stays identity-stable
  const openPath = useStore((s) => (s.diff && s.diff.worktreeId === activeId ? s.diff.path : null));
  const files = gitInfo?.files ?? NO_FILES;
  const committed = gitInfo?.committed ?? NO_FILES;
  const clean = files.length === 0;

  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string; canDiscard: boolean } | null>(null);
  const closeMenu = useCallback(() => setFileMenu(null), []);

  // hover a changed file -> highlight only its changed lines' elements
  const hoverPathRef = useRef<string | null>(null);
  const ranges = useLocalField(activeId, "changedRanges");
  const hoverFile = useCallback(
    (path: string, entering: boolean) => {
      if (!activeId) return;
      if (!entering) {
        hoverPathRef.current = null;
        previewBus.post(activeId, { type: "highlight-clear" });
        return;
      }
      hoverPathRef.current = path;
      const cached = ranges[path];
      if (cached) previewBus.post(activeId, { type: "highlight-file", path, ranges: shiftRanges(cached) });
      else sock?.send({ t: "changed-ranges", worktreeId: activeId, path });
    },
    [activeId, ranges, sock],
  );
  // the ranges arrive after the hover started: light up then
  useEffect(() => {
    const path = hoverPathRef.current;
    if (!path || !activeId) return;
    const cached = ranges[path];
    if (cached) previewBus.post(activeId, { type: "highlight-file", path, ranges: shiftRanges(cached) });
  }, [ranges, activeId]);

  const open = useCallback(
    (path: string) => activeId && sock?.send({ t: "file-diff", worktreeId: activeId, path }),
    [activeId, sock],
  );

  // one flat order across both sections, so ↑↓ crosses the section titles the way the eye does
  const rows = useMemo(() => [...files, ...committed], [files, committed]);
  const listRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState(0);
  const [focused, setFocused] = useState(false);
  useEffect(() => setSel(0), [activeId]);
  // a moved selection has to come into view, and it is the row that scrolls, not the list
  useEffect(() => {
    if (focused) listRef.current?.querySelector<HTMLElement>(".git-file.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel, focused]);
  // ⌘B on a panel that is already open and unfocused lands the keyboard here (the chord itself is
  // in app/keys.ts). Next frame: the dock may be re-appearing in this same commit. The arrows pick
  // up from the file already in the editor, so the first one moves off what you are looking at
  // rather than off the top of the list.
  // (only the request is a dependency: the row list changes on every git-status, and focus is not
  // something to take again because a file was saved somewhere)
  const atOpen = useRef(-1);
  atOpen.current = rows.findIndex((f) => f.path === openPath);
  useEffect(() => {
    if (!focusReq) return;
    if (atOpen.current >= 0) setSel(atOpen.current);
    const f = requestAnimationFrame(() => listRef.current?.focus());
    return () => cancelAnimationFrame(f);
  }, [focusReq]);

  // moving the selection opens the diff, and lights the preview the way hovering the row does
  const select = useCallback(
    (i: number) => {
      const f = rows[i];
      if (!f) return;
      setSel(i);
      open(f.path);
      hoverFile(f.path, true);
    },
    [rows, open, hoverFile],
  );
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      select(step(sel, e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(sel);
    } else if (e.key === "Escape") {
      // the app-wide Escape closes the diff pane, which is the thing this list just opened: here it
      // only hands the keyboard back to the preview
      e.stopPropagation();
      (document.activeElement as HTMLElement | null)?.blur();
    }
  };

  const ctxUncommitted = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    setFileMenu({ x: e.clientX, y: e.clientY, path, canDiscard: true });
  }, []);
  const ctxCommitted = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    setFileMenu({ x: e.clientX, y: e.clientY, path, canDiscard: false });
  }, []);
  const clickRow = useCallback(
    (path: string) => {
      setSel(rows.findIndex((f) => f.path === path));
      open(path);
    },
    [rows, open],
  );

  return (
    <div className={`left-dock ${leftOpen ? "" : "collapsed"}`} style={{ width }}>
      <div
        className="changes-list"
        role="listbox"
        aria-label="changed files"
        tabIndex={0}
        ref={listRef}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        // clicking one row and then another passes through here; only focus actually leaving the
        // list should put the selection band away
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
      >
        {files.length > 0 && (
          <>
            <div className="dock-section-title">uncommitted · {files.length}</div>
            {files.map((f, i) => (
              <GitFileRow
                key={f.path}
                f={f}
                active={f.path === openPath}
                selected={focused && sel === i}
                onOpen={clickRow}
                onContext={ctxUncommitted}
                onHover={hoverFile}
              />
            ))}
          </>
        )}
        {committed.length > 0 && (
          <>
            <div className="dock-section-title" data-tip="Committed on this branch, not yet on main">
              committed · {committed.length}
            </div>
            {committed.map((f, i) => (
              <GitFileRow
                key={`c-${f.path}`}
                f={f}
                active={f.path === openPath}
                selected={focused && sel === files.length + i}
                onOpen={clickRow}
                onContext={ctxCommitted}
                onHover={hoverFile}
              />
            ))}
          </>
        )}
        {clean && committed.length === 0 && <div className="dock-empty">clean</div>}
      </div>
      {active && <CommitBox active={active} ahead={gitInfo?.ahead ?? 0} behind={gitInfo?.behind ?? 0} dirty={!clean} />}
      {fileMenu && active && (
        <Menu
          at={fileMenu}
          onClose={closeMenu}
          items={[
            ...editorItems(`${wtDir(active.worktree)}/${fileMenu.path}`, () =>
              sock?.send({ t: "reveal", worktreeId: active.worktree.id, path: fileMenu.path }),
            ),
            ...(fileMenu.canDiscard
              ? [
                  {
                    label: "discard changes…",
                    danger: true,
                    onClick: () => {
                      if (window.confirm(`Discard uncommitted changes to ${fileMenu.path}?`)) {
                        sock?.send({ t: "discard-file", worktreeId: active.worktree.id, path: fileMenu.path });
                      }
                    },
                  },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}
