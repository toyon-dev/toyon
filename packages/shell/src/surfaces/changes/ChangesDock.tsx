import type { CommitEntry, GitFileStatus } from "@toyon/shared";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { commitItems } from "../../state/actions/commit.ts";
import { fileItems, openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import {
  useActive,
  useActiveId,
  useActiveRow,
  useArchivedPage,
  useFirstRun,
  useLocalField,
} from "../../state/selectors.ts";
import { type ChangesTab, repoById } from "../../state/store.ts";
import { Icon } from "../../ui/Icon.tsx";
import { step } from "../../ui/listNav.ts";
import { type MenuEntry, useContextMenu } from "../../ui/menu.ts";
import { Tabs } from "../../ui/Tabs.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { ago, chord, shiftRanges, wtDir } from "../util.ts";
import { CommitBox } from "./CommitBox.tsx";
import { CommitRow } from "./CommitRow.tsx";
import { FileTree } from "./FileTree.tsx";
import { GitFileRow } from "./GitFileRow.tsx";
import "./changes.css";
import { cx } from "../../ui/cx.ts";
import { useOnChange } from "../../ui/hooks.ts";

/** one array, so a worktree the daemon has not reported on yet does not hand the row list a fresh
 * identity on every render and re-render every row with it */
const NO_FILES: GitFileStatus[] = [];

/** a landing's age, as a section title reads it */
function landedWhen(at: number): string {
  const when = ago(at);
  return when === "now" ? "landed just now" : `landed ${when} ago`;
}

/** a history row is a commit, or one file inside the commit expanded under it */
type HistRow = { commit: CommitEntry; file?: GitFileStatus };

/** the changes panel: the working tree over a commit box, or the branch's history */
export function ChangesDock({ width }: { width: number }) {
  const sock = useSock();
  const dispatch = useDispatch();
  const liveId = useActiveId();
  // an archived worktree's page shows that worktree's work, read from what git kept of it
  const archived = useArchivedPage();
  const shownId = archived?.id ?? liveId;
  const active = useActive();
  const changesOpen = useStore((s) => s.changesOpen);
  // hidden, not closed, on a first-run screen: the layout remembers nothing of it and the panel is
  // back, as it was, with the first message
  const firstRun = useFirstRun();
  const focusReq = useStore((s) => s.focusChanges);
  const gitInfo = useLocalField(shownId, "git");
  // the row whose file is open in the editor; plain strings so the selectors stay identity-stable
  const openPath = useStore((s) => (s.editor && s.editor.worktreeId === shownId ? s.editor.path : null));
  const openRef = useStore((s) => (s.editor && s.editor.worktreeId === shownId ? (s.editor.ref ?? null) : null));
  const files = gitInfo?.files ?? NO_FILES;
  const committed = gitInfo?.committed ?? NO_FILES;
  const clean = files.length === 0;

  const storedTab = useStore((s) => s.changesTab);
  // an archived page has no checkout to list, so it shows its changes and leaves the kept tab be:
  // leaving the page brings the files tab back
  const tab: ChangesTab = archived && storedTab === "files" ? "changes" : storedTab;
  const setTab = useCallback((v: ChangesTab) => dispatch({ a: "changes-tab", v }), [dispatch]);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const treeRef = useRef<HTMLDivElement>(null);
  // names the second half of the history: the commits this branch inherited rather than made. Any
  // row has one: a found worktree's history reads the same way, it just has no commit box under it.
  const activeRow = useActiveRow();
  const defaultBranch = useStore((s) => repoById(s, activeRow?.repoId)?.defaultBranch ?? "main");
  const commits = useLocalField(shownId, "commits");
  const filesBySha = useLocalField(shownId, "commitFiles");
  // only one commit is expanded at a time, which is also what lets a file row below it be opened
  // without carrying its sha: the sha is whichever commit is open
  const [openSha, setOpenSha] = useState<string | null>(null);
  const openShaRef = useRef<string | null>(null);
  openShaRef.current = openSha;

  // hovering a changed file highlights only its changed lines' elements
  const hoverPathRef = useRef<string | null>(null);
  const ranges = useLocalField(shownId, "changedRanges");
  const hoverFile = useCallback(
    (path: string, entering: boolean) => {
      // the preview is the row underneath, and an archived worktree's lines are nowhere on it
      if (!shownId || archived) return;
      if (!entering) {
        hoverPathRef.current = null;
        previewBus.post(shownId, { type: "highlight-clear" });
        return;
      }
      hoverPathRef.current = path;
      const cached = ranges[path];
      if (cached) previewBus.post(shownId, { type: "highlight-file", path, ranges: shiftRanges(cached) });
      else sock?.send({ t: "changed-ranges", worktreeId: shownId, path });
    },
    [shownId, archived, ranges, sock],
  );
  // the ranges arrive after the hover started: light up then
  useEffect(() => {
    const path = hoverPathRef.current;
    if (!path || !shownId) return;
    const cached = ranges[path];
    if (cached) previewBus.post(shownId, { type: "highlight-file", path, ranges: shiftRanges(cached) });
  }, [ranges, shownId]);

  // walking the list opens each file as it arrives, and the keyboard stays here for the next arrow;
  // Enter is the one that takes it into the file
  const open = useCallback(
    (path: string, focus = false) => shownId && openFile({ sock, dispatch }, { worktreeId: shownId, path, focus }),
    [shownId, sock, dispatch],
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
  // an archived worktree's history is only its own commits, so the titles say instead which landing
  // carried each run of them, and which never landed
  const keptTitles = useMemo(() => {
    const titles = new Map<number, string>();
    if (!archived) return titles;
    const counts = new Map<number, number>();
    for (const r of histRows) {
      const at = r.commit.landedAt ?? 0;
      if (!r.file) counts.set(at, (counts.get(at) ?? 0) + 1);
    }
    let last: number | undefined;
    histRows.forEach((r, i) => {
      const at = r.commit.landedAt ?? 0;
      if (at === last) return;
      last = at;
      titles.set(i, `${at ? landedWhen(at) : "not landed"} · ${counts.get(at) ?? 0}`);
    });
    return titles;
  }, [archived, histRows]);
  const listRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState(0);
  const [focused, setFocused] = useState(false);
  // the list marks one row, and it is where you are: the cursor while the list has the keyboard,
  // the file open in the editor while it does not. The cursor drawing an edge and the open file a
  // band split one mark across two rows the moment the arrows left the open file, onto a commit.
  const marked = (i: number, open: boolean) => (focused ? sel === i : open);
  useOnChange([shownId, tab], () => setSel(0));

  // the log is pulled, not pushed: reading it costs a git process, so a worktree nobody is
  // reviewing never pays for one. HEAD moving under an open tab (the agent committed) re-reads it.
  const head = gitInfo?.head;
  const lastLog = useRef("");
  useEffect(() => {
    if (tab !== "history" || !shownId) return;
    const key = `${shownId}:${head ?? ""}`;
    if (lastLog.current === key) return;
    lastLog.current = key;
    sock?.send({ t: "git-log", worktreeId: shownId });
  }, [tab, shownId, head, sock]);
  // a commit's files are fetched once and kept: the same shas are still there after a re-read
  const toggleCommit = useCallback(
    (sha: string) => {
      setOpenSha((prev) => (prev === sha ? null : sha));
      if (shownId && !filesBySha[sha]) sock?.send({ t: "git-commit", worktreeId: shownId, sha });
    },
    [shownId, filesBySha, sock],
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
    // on the files tab the tree takes it, and picks up at the open file itself
    const files = tabRef.current === "files";
    if (!files && atOpen.current >= 0) setSel(atOpen.current);
    const f = requestAnimationFrame(() => (files ? treeRef : listRef).current?.focus());
    return () => cancelAnimationFrame(f);
  }, [focusReq]);

  // moving the selection opens the diff, and lights the preview the way hovering the row does
  const select = useCallback(
    (i: number, focus = false) => {
      const f = rows[i];
      if (!f) return;
      setSel(i);
      open(f.path, focus);
      hoverFile(f.path, true);
    },
    [rows, open, hoverFile],
  );
  /** open a file as one commit left it. The sha is the expanded commit's: only one is ever open. */
  const openAt = useCallback(
    (path: string, focus = false) => {
      const ref = openShaRef.current;
      if (shownId && ref) openFile({ sock, dispatch }, { worktreeId: shownId, path, ref, focus });
    },
    [shownId, sock, dispatch],
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
      if (r.file) openAt(r.file.path, true);
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
      // the arrows preview; Enter opens the file with the keyboard in it, and Esc there comes back here
      e.preventDefault();
      if (hist) enterHist(sel);
      else select(sel, true);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      // ←/→ are both the tab strip's keys and a tree's, and with two tabs they can be both: the
      // tree answers while it has something to say (expand, collapse) and the strip when it does
      // not, so → from the changes list opens the history and ← on a closed commit walks back
      // out. The history is only ever a tree one commit deep, so ← anywhere inside a commit
      // closes it and lands on it: a stop on the parent first is a step nobody asked for in a
      // tree this shallow.
      e.preventDefault();
      const right = e.key === "ArrowRight";
      if (!hist) {
        if (right) setTab("history");
        return;
      }
      const r = histRows[sel];
      if (right) {
        if (!r || r.file) return;
        if (r.commit.sha !== openSha) toggleCommit(r.commit.sha);
        else if (histRows[sel + 1]?.file) moveHist(sel + 1);
      } else if (r && r.commit.sha === openSha) {
        // the commit's own row sits above its files, so its index survives the collapse
        if (r.file) setSel(histRows.findIndex((x) => !x.file && x.commit.sha === r.commit.sha));
        toggleCommit(r.commit.sha);
      } else {
        setTab("changes");
      }
    } else if (e.key === "Escape") {
      // Escape closes what the list opened and leaves the keyboard here, so the arrows can open the
      // next file straight away. Only a list with nothing open hands the keyboard back. It never
      // reaches the app-wide ladder, which would close the terminal ahead of the diff.
      e.stopPropagation();
      if (openPath !== null) dispatch({ a: "close-editor" });
      else (document.activeElement as HTMLElement | null)?.blur();
    }
  };

  // the rows are memoized on their props, so what they are handed to build a menu from is stable
  const wtId = archived ? archived.id : active?.worktree.id;
  const dir = archived ? archived.path : active ? wtDir(active.worktree) : "";
  // an archived worktree's files are only in git: nothing to open elsewhere, reveal or discard
  const kept = archived !== null;
  const menuUncommitted = useCallback(
    (path: string): MenuEntry[] =>
      wtId ? fileItems({ id: wtId, dir }, path, { discard: !kept, kept }, { sock, dispatch }) : [],
    [wtId, dir, kept, sock, dispatch],
  );
  const menuCommitted = useCallback(
    (path: string): MenuEntry[] => (wtId ? fileItems({ id: wtId, dir }, path, { kept }, { sock, dispatch }) : []),
    [wtId, dir, kept, sock, dispatch],
  );
  // a history row's file views open it as that commit left it, the way clicking the row does
  const menuAtCommit = useCallback(
    (path: string): MenuEntry[] =>
      wtId
        ? fileItems({ id: wtId, dir }, path, { ref: openShaRef.current ?? undefined, kept }, { sock, dispatch })
        : [],
    [wtId, dir, kept, sock, dispatch],
  );
  // the list has the keyboard, so shift+F10 lands here rather than on the highlighted row: answer
  // for that row. A right-click reaches a row first and never gets here with a pointer.
  const cm = useContextMenu("changes");
  const selectedMenu = (): MenuEntry[] => {
    if (tab === "changes") {
      const f = rows[sel];
      return f ? (sel < files.length ? menuUncommitted : menuCommitted)(f.path) : [];
    }
    const r = histRows[sel];
    return r ? (r.file ? menuAtCommit(r.file.path) : commitItems(r.commit)) : [];
  };
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
    <div className={cx("changes-dock", (!changesOpen || firstRun) && "collapsed")} style={{ width }}>
      {/* the count is the working tree's: the committed section under it keeps its own title */}
      <Tabs<ChangesTab>
        fill
        owner="changes-tabs"
        label="changes panel"
        items={[
          {
            id: "changes",
            label:
              files.length > 0 ? (
                <>
                  changes <span className="tab-count">{files.length}</span>
                </>
              ) : (
                "changes"
              ),
          },
          { id: "history", label: "history" },
          // every file, behind an icon sized to itself: the tree is there to look things up, and the
          // two lists of work keep the strip
          ...(archived
            ? []
            : [
                {
                  id: "files" as const,
                  label: <Icon name="folder" className="icon-inline" />,
                  fit: true,
                  ariaLabel: "files",
                  tip: tip("files", chord("files")),
                },
              ]),
        ]}
        current={tab}
        onPick={setTab}
      />
      {tab === "files" && shownId ? (
        <FileTree
          worktreeId={shownId}
          dir={active ? wtDir(active.worktree) : (activeRow?.path ?? "")}
          openPath={openPath}
          openRef={openRef}
          rootRef={treeRef}
        />
      ) : (
        <div
          className={cx("changes-list", tab === "history" && "history")}
          role="listbox"
          aria-label={tab === "history" ? "commits" : "changed files"}
          tabIndex={0}
          ref={listRef}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          // a click lands the keyboard on the list, never on the row it hit: a row is a button, and a
          // focused button that a later key unmounts (closing its commit, walking ← out to the other
          // tab) takes the focus down with it, and the panel is deaf until it is clicked again
          // The mark moves on the press, not the release: taking the keyboard hands the mark to the
          // cursor, and a cursor left on some other row would light for the length of the press.
          // The options are rendered in row order, so their index is the row's.
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const hit = (e.target as HTMLElement).closest('[role="option"]');
            const i = hit ? Array.from(e.currentTarget.querySelectorAll('[role="option"]')).indexOf(hit) : -1;
            if (i >= 0) setSel(i);
            listRef.current?.focus();
          }}
          // clicking one row and then another passes through here; only focus actually leaving the
          // list should put the selection band away
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
          {...cm.contextMenu((from) => (from === "keyboard" ? selectedMenu() : []))}
        >
          {tab === "changes" && files.length > 0 && (
            <>
              {/* the tab already says changes and how many; the title is only needed to tell this
                section from the committed one under it */}
              {committed.length > 0 && <div className="section-title">uncommitted · {files.length}</div>}
              {files.map((f, i) => (
                <GitFileRow
                  key={f.path}
                  f={f}
                  active={marked(i, !openRef && f.path === openPath)}
                  selected={focused && sel === i}
                  onOpen={clickRow}
                  menu={menuUncommitted}
                  onHover={hoverFile}
                />
              ))}
            </>
          )}
          {tab === "changes" && committed.length > 0 && (
            <>
              <div
                className="section-title"
                data-tip="Committed on this branch, not yet on main"
                data-tip-placement="follow"
              >
                committed · {committed.length}
              </div>
              {committed.map((f, i) => (
                <GitFileRow
                  key={`c-${f.path}`}
                  f={f}
                  active={marked(files.length + i, !openRef && f.path === openPath)}
                  selected={focused && sel === files.length + i}
                  onOpen={clickRow}
                  menu={menuCommitted}
                  onHover={hoverFile}
                />
              ))}
            </>
          )}
          {tab === "changes" && clean && committed.length === 0 && (
            <div className="empty">
              {archived ? (archived.landed ? "all of it landed" : "nothing that is not on main") : "clean"}
            </div>
          )}
          {tab === "history" &&
            histRows.map((r, i) => (
              <Fragment key={r.file ? `${r.commit.sha}:${r.file.path}` : r.commit.sha}>
                {archived && keptTitles.has(i) && <div className="section-title">{keptTitles.get(i)}</div>}
                {!archived && aheadCount > 0 && i === 0 && (
                  <div className="section-title">on this branch · {aheadCount}</div>
                )}
                {!archived && aheadCount > 0 && i === firstLanded && (
                  <div className="section-title">{defaultBranch}</div>
                )}
                {r.file ? (
                  <GitFileRow
                    f={r.file}
                    active={marked(i, openRef === r.commit.sha && r.file.path === openPath)}
                    selected={focused && sel === i}
                    onOpen={clickHistFile}
                    menu={menuAtCommit}
                    onHover={noHover}
                  />
                ) : (
                  <CommitRow c={r.commit} selected={focused && sel === i} onToggle={clickCommit} />
                )}
              </Fragment>
            ))}
          {tab === "history" && commits === undefined && <div className="empty">reading history…</div>}
          {tab === "history" && commits?.length === 0 && <div className="empty">no commits yet</div>}
        </div>
      )}
      {activeRow && !archived && (
        <CommitBox active={activeRow} ahead={gitInfo?.ahead ?? 0} behind={gitInfo?.behind ?? 0} dirty={!clean} />
      )}
    </div>
  );
}
