import type { CommitEntry, GitFileStatus } from "@toyon/shared";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useSock, useStore } from "../../state/context.tsx";
import { useActive, useActiveId, useLocalField } from "../../state/selectors.ts";
import { repoById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { step } from "../../ui/listNav.ts";
import { editorItems, Menu } from "../../ui/Menu.tsx";
import { shiftRanges, wtDir } from "../util.ts";
import { CommitBox } from "./CommitBox.tsx";
import { CommitRow } from "./CommitRow.tsx";
import { GitFileRow } from "./GitFileRow.tsx";
import "./changes.css";
import { cx } from "../../ui/cx.ts";
import { useOnChange } from "../../ui/hooks.ts";

/** one array, so a worktree the daemon has not reported on yet does not hand the row list a fresh
 * identity on every render and re-render every row with it */
const NO_FILES: GitFileStatus[] = [];

/** which list the panel is showing: the working tree, or the branch's commits */
type Tab = "changes" | "history";

/** a history row is a commit, or one file inside the commit expanded under it */
type HistRow = { commit: CommitEntry; file?: GitFileStatus };

/** the changes panel: the working tree over a commit box, or the branch's history */
export function LeftDock({ width }: { width: number }) {
  const sock = useSock();
  const activeId = useActiveId();
  const active = useActive();
  const leftOpen = useStore((s) => s.leftOpen);
  const focusReq = useStore((s) => s.focusLeft);
  const gitInfo = useLocalField(activeId, "git");
  // the row whose diff is open in the editor; plain strings so the selectors stay identity-stable
  const openPath = useStore((s) => (s.diff && s.diff.worktreeId === activeId ? s.diff.path : null));
  const openRef = useStore((s) => (s.diff && s.diff.worktreeId === activeId ? (s.diff.ref ?? null) : null));
  const files = gitInfo?.files ?? NO_FILES;
  const committed = gitInfo?.committed ?? NO_FILES;
  const clean = files.length === 0;

  const [tab, setTab] = useState<Tab>("changes");
  // names the second half of the history: the commits this branch inherited rather than made
  const defaultBranch = useStore((s) => repoById(s, active?.worktree.repoId)?.defaultBranch ?? "main");
  const commits = useLocalField(activeId, "commits");
  const filesBySha = useLocalField(activeId, "commitFiles");
  // only one commit is expanded at a time, which is also what lets a file row below it be opened
  // without carrying its sha: the sha is whichever commit is open
  const [openSha, setOpenSha] = useState<string | null>(null);
  const openShaRef = useRef<string | null>(null);
  openShaRef.current = openSha;

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
  // the expanded commit's files sit in the same flat order, so the arrows walk into a commit and
  // out the other side without the list needing a notion of depth
  const histRows = useMemo(() => {
    const out: HistRow[] = [];
    for (const c of commits ?? []) {
      out.push({ commit: c });
      if (c.sha === openSha) for (const f of filesBySha[c.sha] ?? []) out.push({ commit: c, file: f });
    }
    return out;
  }, [commits, openSha, filesBySha]);
  // the ahead commits are a contiguous run at the top, so where the run ends is the one place the
  // list has to say so. Two titles rather than a mark on every row, and none at all on a worktree
  // whose branch is the default one, where every commit is inherited history.
  const aheadCount = useMemo(() => histRows.filter((r) => !r.file && r.commit.ahead).length, [histRows]);
  const firstLanded = useMemo(() => histRows.findIndex((r) => !r.file && !r.commit.ahead), [histRows]);
  const listRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState(0);
  const [focused, setFocused] = useState(false);
  useOnChange([activeId, tab], () => setSel(0));

  // the log is pulled, not pushed: reading it costs a git process, so a worktree nobody is
  // reviewing never pays for one. HEAD moving under an open tab (the agent committed) re-reads it.
  const head = gitInfo?.head;
  const lastLog = useRef("");
  useEffect(() => {
    if (tab !== "history" || !activeId) return;
    const key = `${activeId}:${head ?? ""}`;
    if (lastLog.current === key) return;
    lastLog.current = key;
    sock?.send({ t: "git-log", worktreeId: activeId });
  }, [tab, activeId, head, sock]);
  // a commit's files are fetched once and kept: the same shas are still there after a re-read
  const toggleCommit = useCallback(
    (sha: string) => {
      setOpenSha((prev) => (prev === sha ? null : sha));
      if (activeId && !filesBySha[sha]) sock?.send({ t: "git-commit", worktreeId: activeId, sha });
    },
    [activeId, filesBySha, sock],
  );
  // a moved selection has to come into view, and it is the row that scrolls, not the list
  useOnChange([sel, focused], () => {
    // a file row or a commit row: both carry the cursor state, and only one of them ever has it
    if (focused)
      listRef.current?.querySelector<HTMLElement>('[data-state~="cursor"]')?.scrollIntoView({ block: "nearest" });
  });
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
  /** open a file as one commit left it. The sha is the expanded commit's: only one is ever open. */
  const openAt = useCallback(
    (path: string) => {
      const ref = openShaRef.current;
      if (activeId && ref) sock?.send({ t: "file-diff", worktreeId: activeId, path, ref });
    },
    [activeId, sock],
  );
  // arrows only move over a commit: expanding every row they crossed would push the list around
  // under the person walking it. A file row opens on arrival, the way the changes list does.
  const moveHist = useCallback(
    (i: number) => {
      const r = histRows[i];
      if (!r) return;
      setSel(i);
      if (r.file) openAt(r.file.path);
    },
    [histRows, openAt],
  );
  const enterHist = useCallback(
    (i: number) => {
      const r = histRows[i];
      if (!r) return;
      setSel(i);
      if (r.file) openAt(r.file.path);
      else toggleCommit(r.commit.sha);
    },
    [histRows, openAt, toggleCommit],
  );
  const onKeyDown = (e: React.KeyboardEvent) => {
    const hist = tab === "history";
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = step(sel, e.key === "ArrowDown" ? 1 : -1, hist ? histRows.length : rows.length);
      if (hist) moveHist(i);
      else select(i);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hist) enterHist(sel);
      else select(sel);
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
  const clickCommit = useCallback(
    (sha: string) => {
      setSel(histRows.findIndex((r) => !r.file && r.commit.sha === sha));
      toggleCommit(sha);
    },
    [histRows, toggleCommit],
  );
  const clickHistFile = useCallback(
    (path: string) => {
      setSel(histRows.findIndex((r) => r.file?.path === path));
      openAt(path);
    },
    [histRows, openAt],
  );
  // the preview shows the working tree, so a line in a commit has nowhere on the page to light up
  const noHover = useCallback(() => {}, []);

  return (
    <div className={cx("left-dock", !leftOpen && "collapsed")} style={{ width }}>
      <div className="changes-tabs" role="tablist">
        {(["changes", "history"] as const).map((t) => (
          <Button
            key={t}
            role="tab"
            variant="outline"
            className="changes-tab"
            on={tab === t}
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </Button>
        ))}
      </div>
      <div
        className={cx("changes-list", tab === "history" && "history")}
        role="listbox"
        aria-label={tab === "history" ? "commits" : "changed files"}
        tabIndex={0}
        ref={listRef}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        // clicking one row and then another passes through here; only focus actually leaving the
        // list should put the selection band away
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
      >
        {tab === "changes" && files.length > 0 && (
          <>
            <div className="section-title">uncommitted · {files.length}</div>
            {files.map((f, i) => (
              <GitFileRow
                key={f.path}
                f={f}
                active={!openRef && f.path === openPath}
                selected={focused && sel === i}
                onOpen={clickRow}
                onContext={ctxUncommitted}
                onHover={hoverFile}
              />
            ))}
          </>
        )}
        {tab === "changes" && committed.length > 0 && (
          <>
            <div className="section-title" data-tip="Committed on this branch, not yet on main">
              committed · {committed.length}
            </div>
            {committed.map((f, i) => (
              <GitFileRow
                key={`c-${f.path}`}
                f={f}
                active={!openRef && f.path === openPath}
                selected={focused && sel === files.length + i}
                onOpen={clickRow}
                onContext={ctxCommitted}
                onHover={hoverFile}
              />
            ))}
          </>
        )}
        {tab === "changes" && clean && committed.length === 0 && <div className="empty">clean</div>}
        {tab === "history" &&
          histRows.map((r, i) => (
            <Fragment key={r.file ? `${r.commit.sha}:${r.file.path}` : r.commit.sha}>
              {aheadCount > 0 && i === 0 && <div className="section-title">on this branch · {aheadCount}</div>}
              {aheadCount > 0 && i === firstLanded && <div className="section-title">{defaultBranch}</div>}
              {r.file ? (
                <GitFileRow
                  f={r.file}
                  active={openRef === r.commit.sha && r.file.path === openPath}
                  selected={focused && sel === i}
                  onOpen={clickHistFile}
                  onContext={ctxCommitted}
                  onHover={noHover}
                />
              ) : (
                <CommitRow
                  c={r.commit}
                  open={r.commit.sha === openSha}
                  selected={focused && sel === i}
                  onToggle={clickCommit}
                />
              )}
            </Fragment>
          ))}
        {tab === "history" && commits === undefined && <div className="empty">reading history…</div>}
        {tab === "history" && commits?.length === 0 && <div className="empty">no commits yet</div>}
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
