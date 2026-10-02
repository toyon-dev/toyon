import { baseOf, type CommitEntry, type GitFileStatus } from "@toyon/shared";
import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { commitItems } from "../../state/actions/commit.ts";
import { discardQuestion, fileItems, openFile } from "../../state/actions/file.ts";
import { mentionFilesInChat } from "../../state/attach.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import {
  useActive,
  useActiveId,
  useActiveRow,
  useArchivedPage,
  useBare,
  useLocalField,
} from "../../state/selectors.ts";
import { type ChangesTab, changesTabShown, repoById } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { step } from "../../ui/listNav.ts";
import { type MenuEntry, useContextMenu } from "../../ui/menu.ts";
import { Tabs } from "../../ui/Tabs.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { ago, chord, shiftRanges } from "../util.ts";
import { CommitBox } from "./CommitBox.tsx";
import { CommitRow } from "./CommitRow.tsx";
import { FileTree } from "./FileTree.tsx";
import { GitFileRow } from "./GitFileRow.tsx";
import { TestNames } from "./TestNames.tsx";
import { isTestPath, testsLast } from "./testFiles.ts";
import { type ChangedTest, changedTests } from "./testNames.ts";
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

interface Cursor {
  row: number;
  at: number;
}

/** a row the list numbers: a file or a commit, and not a test name under a file */
const ROW = '[role="option"]:not([data-sub])';

/** no test file is open, or its change names no test */
const NO_TESTS: ChangedTest[] = [];

/** a history row is a commit, or one file inside the commit expanded under it */
type HistRow = { commit: CommitEntry; file?: GitFileStatus };

/** the changes panel: the working tree over a commit box, or the branch's history. `width` is the
 * dock's, held by the docks row. On a phone it is a screen instead: the whole column, never
 * collapsed, since the tab that shows it is the only way it is reached there. */
export function ChangesDock({ width, placement = "dock" }: { width?: number; placement?: "dock" | "screen" }) {
  const onScreen = placement === "screen";
  const sock = useSock();
  const dispatch = useDispatch();
  const store = useStoreInstance();
  const liveId = useActiveId();
  // an archived worktree's page shows that worktree's work, read from what git kept of it
  const archived = useArchivedPage();
  const shownId = archived?.id ?? liveId;
  const active = useActive();
  const changesOpen = useStore((s) => s.layout.changes);
  // hidden, not closed, on a first-run screen: the layout remembers nothing of it and the panel is
  // back, as it was, with the first message
  const bare = useBare();
  const focusReq = useStore((s) => s.focusChanges);
  const gitInfo = useLocalField(shownId, "git");
  // the row whose file is open in the editor; plain strings so the selectors stay identity-stable
  const openPath = useStore((s) => (s.editor && s.editor.worktreeId === shownId ? s.editor.path : null));
  const openRef = useStore((s) => (s.editor && s.editor.worktreeId === shownId ? (s.editor.ref ?? null) : null));
  // each list reads the change first and its tests after: the order every index below is in, so
  // the arrows, the pick and the titles agree with what is drawn
  const statusFiles = gitInfo?.files ?? NO_FILES;
  const statusCommitted = gitInfo?.committed ?? NO_FILES;
  const { files, source: fileSource } = useMemo(() => testsLast(statusFiles), [statusFiles]);
  const { files: committed, source: committedSource } = useMemo(() => testsLast(statusCommitted), [statusCommitted]);
  // a title splits a list only when it holds both kinds: a list of tests alone is just the list
  // A test file is one row until it is opened: then the tests its change touched are listed under
  // it, read from the two sides the editor holds. One file's names at a time, as one commit's files.
  const openDisk = useStore((s) => (s.editor && s.editor.worktreeId === shownId ? s.editor.disk : null));
  const openTests = useMemo(
    () =>
      openPath !== null && openDisk && isTestPath(openPath)
        ? changedTests(openPath, openDisk.before, openDisk.after)
        : NO_TESTS,
    [openPath, openDisk],
  );
  const fileTests = fileSource > 0 ? files.length - fileSource : 0;
  const committedTests = committedSource > 0 ? committed.length - committedSource : 0;
  const clean = files.length === 0;

  const tab = useStore(changesTabShown);
  // an archived page has no strip: the worktree's whole life is one list, what it left uncommitted
  // over its history, each run of commits headed by the landing that carried it
  const showChanges = archived !== null || tab === "changes";
  const showHist = archived !== null || tab === "history";
  const setTab = useCallback((v: ChangesTab) => dispatch({ a: "changes-tab", v }), [dispatch]);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const treeRef = useRef<HTMLDivElement>(null);
  // names the second half of the history: the commits this branch inherited rather than made. Any
  // row has one: a found worktree's history reads the same way, it just has no commit box under it.
  // It is the base the counts are against: main here, or origin's main where the route lands there.
  const activeRow = useActiveRow();
  const base = useStore((s) => {
    const repo = repoById(s, activeRow?.repoId);
    return repo ? baseOf(repo) : "main";
  });
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

  // An archived worktree's uncommitted work is a snapshot commit over its kept head, and the status
  // names that snapshot as its head. Its file rows open that commit's own diff, the uncommitted
  // change alone, rather than the branch's whole unlanded tail.
  const snapRef = archived && files.length > 0 ? (gitInfo?.head ?? null) : null;
  // walking the list opens each file as it arrives, and the keyboard stays here for the next arrow;
  // Enter is the one that takes it into the file
  const open = useCallback(
    (path: string, focus = false) =>
      shownId && openFile({ sock, dispatch }, { worktreeId: shownId, path, focus, ref: snapRef ?? undefined }),
    [shownId, snapRef, sock, dispatch],
  );

  // one flat order across both sections, so ↑↓ crosses the section titles the way the eye does. An
  // archived page's unlanded commits are the "not landed" run of the history under it, files and
  // all, so their flat file list is not repeated above them.
  const rows = useMemo(() => (archived ? files : [...files, ...committed]), [archived, files, committed]);
  // the expanded commit's files sit in the same flat order, so the arrows walk into a commit and
  // out the other side without the list needing a notion of depth
  const histRows = useMemo(() => {
    const out: HistRow[] = [];
    for (const c of commits ?? []) {
      out.push({ commit: c });
      if (c.sha === openSha) for (const f of testsLast(filesBySha[c.sha] ?? []).files) out.push({ commit: c, file: f });
    }
    return out;
  }, [commits, openSha, filesBySha]);
  // the ahead commits are a contiguous run at the top, so where the run ends is the one place the
  // list has to say so. Two titles rather than a mark on every row, and none at all on a worktree
  // whose branch is the default one, where every commit is inherited history.
  const aheadCount = useMemo(() => histRows.filter((r) => !r.file && r.commit.ahead).length, [histRows]);
  const firstLanded = useMemo(() => histRows.findIndex((r) => !r.file && !r.commit.ahead), [histRows]);
  // the history's rows are numbered after the uncommitted ones when both are on the page, so one
  // cursor walks from the last uncommitted file into the first commit
  const above = archived ? rows.length : 0;
  const total = (showChanges ? rows.length : 0) + (showHist ? histRows.length : 0);
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
  // The cursor: a row, and under an open test file the name it is on (`at`, -1 on the row itself).
  // The rows keep their numbers whichever file is open, so a name is a step inside a row and not a
  // row of its own; moving to a row by its number lands on the row, never on a name left under it.
  const [{ row: sel, at: selName }, setSel] = useReducer(
    (_: Cursor, to: number | Cursor): Cursor => (typeof to === "number" ? { row: to, at: -1 } : to),
    { row: 0, at: -1 },
  );
  const [focused, setFocused] = useState(false);
  // the list marks one row, and it is where you are: the cursor while the list has the keyboard,
  // the file open in the editor while it does not. The cursor drawing an edge and the open file a
  // band split one mark across two rows the moment the arrows left the open file, onto a commit.
  const marked = (i: number, open: boolean) => (focused ? cursorOn(i) : open);
  // The list holds the keyboard and none of its rows can take focus, so a reader is told where the
  // cursor is by the list pointing at that row rather than by focus moving to it. One scheme for
  // both lists: only one of them is rendered at a time.
  const rowId = (i: number) => `changes-row-${i}`;

  // The pick: uncommitted files checked to be discarded or named in the chat together, the way
  // the rail checks worktrees for a graft. A shift-click on a row opens it, and while it is open
  // every uncommitted row shows a box and a click checks rather than opens. Only the working
  // tree's own rows: a committed or historical file has nothing to discard, and an archived page
  // has no chat to name one in.
  const [picking, setPicking] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const cancelPick = useCallback(() => {
    setPicking(false);
    setChecked([]);
  }, []);
  const check = useCallback((path: string) => {
    setPicking(true);
    setChecked((c) => (c.includes(path) ? c.filter((p) => p !== path) : [...c, path]));
  }, []);
  // in the list's order, not the order they were checked in: it is how the confirm lists them and
  // how the chat names them
  const picked = useMemo(() => files.filter((f) => checked.includes(f.path)).map((f) => f.path), [files, checked]);
  // a file that left the list (discarded, or committed by the agent) leaves the pick with it
  useOnChange([files], () =>
    setChecked((c) => {
      const kept = c.filter((p) => files.some((f) => f.path === p));
      return kept.length === c.length ? c : kept;
    }),
  );
  // Esc from anywhere ends the pick, as the rail's does; the list has its own Esc below, and stops
  // the key there, so a pick ended from the list is ended once
  useOnChange([picking], () => {
    if (!picking) return;
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && cancelPick();
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  });
  useOnChange([shownId, tab], () => {
    setSel(0);
    cancelPick();
  });

  // the log is pulled, not pushed: reading it costs a git process, so a worktree nobody is
  // reviewing never pays for one. HEAD moving under an open tab (the agent committed) re-reads it.
  const head = gitInfo?.head;
  const lastLog = useRef("");
  useEffect(() => {
    if (!showHist || !shownId) return;
    const key = `${shownId}:${head ?? ""}`;
    if (lastLog.current === key) return;
    lastLog.current = key;
    sock?.send({ t: "git-log", worktreeId: shownId });
  }, [showHist, shownId, head, sock]);
  // a commit's files are fetched once and kept: the same shas are still there after a re-read
  const toggleCommit = useCallback(
    (sha: string) => {
      setOpenSha((prev) => (prev === sha ? null : sha));
      if (shownId && !filesBySha[sha]) sock?.send({ t: "git-commit", worktreeId: shownId, sha });
    },
    [shownId, filesBySha, sock],
  );
  // a moved selection has to come into view, and it is the row that scrolls, not the list
  useOnChange([sel, selName, focused], () => {
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
  // the open file's index means a row only among the uncommitted ones, and only when it is open
  // as they open it: a history commit's copy of the same path is another row
  const atOpen = useRef(-1);
  atOpen.current = showChanges && openRef === snapRef ? rows.findIndex((f) => f.path === openPath) : -1;
  useEffect(() => {
    if (!focusReq) return;
    // on the files tab the tree takes it, and picks up at the open file itself
    const files = tabRef.current === "files";
    if (atOpen.current >= 0) setSel(atOpen.current);
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
  // (`i` is the list's index: the history row is the one `above` rows down from it)
  const moveHist = useCallback(
    (i: number) => {
      const r = histRows[i - above];
      if (!r) return;
      setSel(i);
      if (r.file) openAt(r.file.path);
    },
    [histRows, above, openAt],
  );
  const enterHist = useCallback(
    (i: number) => {
      const r = histRows[i - above];
      if (!r) return;
      setSel(i);
      if (r.file) openAt(r.file.path, true);
      else toggleCommit(r.commit.sha);
    },
    [histRows, above, openAt, toggleCommit],
  );
  // a row past the uncommitted ones is the history's: every row on the history tab, and on an
  // archived page the ones under its uncommitted files
  const inHist = (i: number) => showHist && i >= above;
  /** the row is the file the editor has open, as that row opens it */
  const rowIsOpen = (i: number): boolean => {
    if (openPath === null) return false;
    if (showChanges && i < rows.length)
      return rows[i]?.path === openPath && (i < files.length ? openRef === snapRef : !openRef);
    const r = inHist(i) ? histRows[i - above] : undefined;
    return !!r?.file && openRef === r.commit.sha && r.file.path === openPath;
  };
  /** the names under a row: the open file's, under the row that opened it */
  const namesAt = (i: number) => (rowIsOpen(i) ? openTests : NO_TESTS);
  // the name the cursor is on, or -1 while it is on a row
  const onName = selName < namesAt(sel).length ? selName : -1;
  const cursorOn = (i: number) => focused && sel === i && onName < 0;
  /** show the open file at one of its tests; the keyboard stays here unless Enter sent it */
  const showTest = (at: number, focus = false) => {
    const t = openTests[at];
    if (!t || !shownId || openPath === null) return;
    openFile(
      { sock, dispatch },
      { worktreeId: shownId, path: openPath, ref: openRef ?? undefined, line: { n: t.line }, focus },
    );
  };
  const names = (i: number) =>
    namesAt(i).length > 0 && (
      <TestNames
        tests={openTests}
        id={rowId(i)}
        cursor={focused && sel === i ? onName : -1}
        onPick={(at) => {
          setSel({ row: i, at });
          showTest(at);
        }}
      />
    );
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (picking && e.key === "Escape") {
      // the pick ends before anything it was opened over closes
      e.preventDefault();
      e.stopPropagation();
      cancelPick();
    } else if (picking && e.key === " ") {
      // the keyboard's check: the row the cursor is on, when it is one of the working tree's
      e.preventDefault();
      const f = showChanges && sel < files.length ? files[sel] : undefined;
      if (f) check(f.path);
    } else if (e.key === "ArrowDown" && onName + 1 < namesAt(sel).length) {
      // ↓ on an open test file walks its names before it reaches the next file
      e.preventDefault();
      setSel({ row: sel, at: onName + 1 });
      showTest(onName + 1);
    } else if ((e.key === "ArrowUp" || e.key === "ArrowLeft") && onName >= 0) {
      // ↑ walks back up them and off the first onto the file's own row, where ← goes from any
      e.preventDefault();
      if (e.key === "ArrowLeft" || onName === 0) setSel(sel);
      else {
        setSel({ row: sel, at: onName - 1 });
        showTest(onName - 1);
      }
    } else if (e.key === "Enter" && onName >= 0) {
      e.preventDefault();
      showTest(onName, true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = step(sel, e.key === "ArrowDown" ? 1 : -1, total);
      if (inHist(i)) moveHist(i);
      else select(i);
    } else if (e.key === "Enter") {
      // the arrows preview; Enter opens the file with the keyboard in it, and Esc there comes back here
      e.preventDefault();
      if (inHist(sel)) enterHist(sel);
      else select(sel, true);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      // ←/→ belong to the tree under them and never to the strip: a deep file in the files tree has
      // no way to tell a step out from a walk away, so the tabs are ⌥←/⌥→ (app/keys.ts) on every
      // tab alike. The history is only ever a tree one commit deep, so ← anywhere inside a commit
      // closes it and lands on it: a stop on the parent first is a step nobody asked for in a tree
      // this shallow.
      e.preventDefault();
      const r = inHist(sel) ? histRows[sel - above] : undefined;
      if (!r) return;
      if (e.key === "ArrowRight") {
        if (r.file) return;
        if (r.commit.sha !== openSha) toggleCommit(r.commit.sha);
        else if (histRows[sel - above + 1]?.file) moveHist(sel + 1);
      } else if (r.commit.sha === openSha) {
        // the commit's own row sits above its files, so its index survives the collapse
        if (r.file) setSel(above + histRows.findIndex((x) => !x.file && x.commit.sha === r.commit.sha));
        toggleCommit(r.commit.sha);
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
  const dir = archived ? archived.path : active ? active.worktree.path : "";
  // an archived worktree's files are only in git: nothing to open elsewhere, reveal or discard
  const kept = archived !== null;
  const menuUncommitted = useCallback(
    (path: string): MenuEntry[] =>
      wtId
        ? fileItems(
            { id: wtId, dir },
            path,
            { discard: !kept, kept, ref: snapRef ?? undefined, select: kept ? undefined : check },
            { sock, dispatch },
          )
        : [],
    [wtId, dir, kept, snapRef, check, sock, dispatch],
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
    if (showChanges && sel < rows.length) {
      const f = rows[sel];
      return f ? (sel < files.length ? menuUncommitted : menuCommitted)(f.path) : [];
    }
    const r = inHist(sel) ? histRows[sel - above] : undefined;
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
      setSel(above + histRows.findIndex((r) => !r.file && r.commit.sha === sha));
      toggleCommit(sha);
    },
    [histRows, above, toggleCommit],
  );
  const clickHistFile = useCallback(
    (path: string) => {
      setSel(above + histRows.findIndex((r) => r.file?.path === path));
      openAt(path);
    },
    [histRows, above, openAt],
  );
  // the preview shows the working tree, so a line in a commit has nowhere on the page to light up
  const noHover = useCallback(() => {}, []);

  return (
    <div
      className={cx("changes-dock", onScreen && "changes-screen", !onScreen && (!changesOpen || bare) && "collapsed")}
      style={onScreen ? undefined : { width }}
    >
      {/* the count is the working tree's: the committed section under it keeps its own title */}
      {!archived && (
        <Tabs<ChangesTab>
          fill
          owner="changes-tabs"
          label="changes panel"
          items={[
            // every file, behind an icon sized to itself: the tree is there to look things up, and
            // the two lists of work keep the strip
            {
              id: "files",
              label: <Icon name="folder" className="icon-inline" />,
              fit: true,
              ariaLabel: "files",
              tip: tip("files", chord("files")),
            },
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
          ]}
          current={tab}
          onPick={setTab}
        />
      )}
      {tab === "files" && shownId ? (
        <FileTree
          worktreeId={shownId}
          dir={active ? active.worktree.path : (activeRow?.path ?? "")}
          openPath={openPath}
          openRef={openRef}
          rootRef={treeRef}
        />
      ) : (
        <div
          className={cx("changes-list", showHist && "history")}
          role="listbox"
          aria-label={archived ? "kept work" : showHist ? "commits" : "changed files"}
          aria-activedescendant={
            focused && sel >= 0 && sel < total ? (onName < 0 ? rowId(sel) : `${rowId(sel)}-t${onName}`) : undefined
          }
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
            const hit = (e.target as HTMLElement).closest(ROW);
            const i = hit ? Array.from(e.currentTarget.querySelectorAll(ROW)).indexOf(hit) : -1;
            if (i >= 0) setSel(i);
            listRef.current?.focus();
          }}
          // clicking one row and then another passes through here; only focus actually leaving the
          // list should put the selection band away
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
          {...cm.contextMenu((from) => (from === "keyboard" ? selectedMenu() : []))}
        >
          {showChanges && files.length > 0 && (
            <>
              {/* the tab already says changes and how many; the title is only needed to tell this
                section from the committed one under it, or on an archived page from the history */}
              {(committed.length > 0 || archived) && (
                <div className="section-title">uncommitted · {files.length - fileTests}</div>
              )}
              {files.map((f, i) => (
                <Fragment key={f.path}>
                  {fileTests > 0 && i === fileSource && (
                    <div className="section-title">
                      {committed.length > 0 || archived ? "uncommitted tests" : "tests"} · {fileTests}
                    </div>
                  )}
                  <GitFileRow
                    f={f}
                    id={rowId(i)}
                    active={marked(i, rowIsOpen(i))}
                    selected={cursorOn(i)}
                    checking={picking}
                    checked={checked.includes(f.path)}
                    onOpen={clickRow}
                    onCheck={kept ? undefined : check}
                    menu={menuUncommitted}
                    onHover={hoverFile}
                  />
                  {names(i)}
                </Fragment>
              ))}
            </>
          )}
          {showChanges && !archived && committed.length > 0 && (
            <>
              <div
                className="section-title"
                data-tip={`Committed on this branch, not yet on ${base}`}
                data-tip-placement="follow"
              >
                committed · {committed.length - committedTests}
              </div>
              {committed.map((f, i) => (
                <Fragment key={`c-${f.path}`}>
                  {committedTests > 0 && i === committedSource && (
                    <div className="section-title">committed tests · {committedTests}</div>
                  )}
                  <GitFileRow
                    f={f}
                    id={rowId(files.length + i)}
                    active={marked(files.length + i, rowIsOpen(files.length + i))}
                    selected={cursorOn(files.length + i)}
                    onOpen={clickRow}
                    menu={menuCommitted}
                    onHover={hoverFile}
                  />
                  {names(files.length + i)}
                </Fragment>
              ))}
            </>
          )}
          {showChanges && !archived && clean && committed.length === 0 && <div className="empty">clean</div>}
          {showHist &&
            histRows.map((r, i) => (
              <Fragment key={r.file ? `${r.commit.sha}:${r.file.path}` : r.commit.sha}>
                {archived && keptTitles.has(i) && <div className="section-title">{keptTitles.get(i)}</div>}
                {!archived && aheadCount > 0 && i === 0 && (
                  <div className="section-title">on this branch · {aheadCount}</div>
                )}
                {!archived && aheadCount > 0 && i === firstLanded && <div className="section-title">{base}</div>}
                {r.file ? (
                  <>
                    <GitFileRow
                      f={r.file}
                      id={rowId(above + i)}
                      active={marked(above + i, rowIsOpen(above + i))}
                      selected={cursorOn(above + i)}
                      onOpen={clickHistFile}
                      menu={menuAtCommit}
                      onHover={noHover}
                    />
                    {names(above + i)}
                  </>
                ) : (
                  <CommitRow c={r.commit} id={rowId(above + i)} selected={cursorOn(above + i)} onToggle={clickCommit} />
                )}
              </Fragment>
            ))}
          {showHist && commits === undefined && <div className="empty">reading history…</div>}
          {showHist && commits?.length === 0 && files.length === 0 && <div className="empty">no commits yet</div>}
        </div>
      )}
      {picking && (
        <div className="changes-pick">
          <Button
            size="md"
            tone="danger"
            disabled={picked.length === 0}
            data-tip="Throw away the uncommitted changes to every checked file"
            onClick={() => {
              if (!wtId || picked.length === 0) return;
              if (window.confirm(discardQuestion(picked))) {
                sock?.send({ t: "discard-files", worktreeId: wtId, paths: picked });
                cancelPick();
              }
            }}
          >
            discard {picked.length}…
          </Button>
          <Button
            size="md"
            disabled={picked.length === 0}
            data-tip="Name every checked file in the chat"
            onClick={() => {
              if (wtId) mentionFilesInChat(store, wtId, picked);
              cancelPick();
            }}
          >
            add to chat
          </Button>
          <IconButton icon="close" label="Cancel" hint="esc" onClick={cancelPick} />
        </div>
      )}
      {activeRow && !archived && (
        <CommitBox
          active={activeRow}
          ahead={gitInfo?.ahead ?? 0}
          behind={gitInfo?.behind ?? 0}
          unpushed={gitInfo?.unpushed ?? activeRow.unpushed ?? 0}
          dirty={!clean}
        />
      )}
    </div>
  );
}
