import { renderedAs, viewerOf } from "@toyon/shared";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeCopiedSource } from "../../app/copiedSource.ts";
import { previewBus } from "../../app/previewBus.ts";
import { fileItems } from "../../state/actions/file.ts";
import { addToChat } from "../../state/attach.ts";
import { useDispatch, useFileSync, useSock, useStore, useStoreInstance, useUrls } from "../../state/context.tsx";
import type { FileSync } from "../../state/fileSync.ts";
import { browserEnv, looseSync, NO_SYNC } from "../../state/looseSync.ts";
import { useTheme } from "../../state/selectors.ts";
import {
  archivedPageOf,
  type ChatItem,
  type EditorDisk,
  type EditorFile,
  isChatCentred,
  localOf,
  routeTarget,
  worktreeById,
  zenShowsFile,
} from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { ErrorBoundary } from "../../ui/ErrorBoundary.tsx";
import { useAtLeast, useOnChange, useSettled } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Pane } from "../../ui/Pane.tsx";
import { type TabItem, Tabs } from "../../ui/Tabs.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { endCarry, startCarry, useCarries } from "../chat/carried.ts";
import { defaultTab, handoffOn, listPage } from "../chat/handoff.ts";
import { usePlanTitle } from "../chat/usePlanTitle.ts";
import { ZenToggle } from "../topbar/ZenToggle.tsx";
import { splitPath } from "../util.ts";
import { type DiffSeat, DiffSeats, SPLIT_MIN, useSplit } from "./DiffSeats.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { HandoffTrack, PiecePage, usePieceTabs } from "./Handoff.tsx";
import { HtmlPreview, servedPath } from "./HtmlPreview.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";
import { PrCommentsPage } from "./PrCommentsPage.tsx";
import { SvgPreview } from "./SvgPreview.tsx";
import { useWrap } from "./wrap.ts";
import "./editor.css";

// the grammars come in with the editor, and a file is only shown once they can colour it
const Editor = lazy(async () => {
  const [editor] = await Promise.all([import("./Editor.tsx"), import("./grammar.ts").then((g) => g.grammarsReady)]);
  return editor;
});

/** A local read lands in a few milliseconds, and a line painted for that long is a flicker; it only
 * says something once the wait is long enough to wonder about. */
function Loading({ what }: { what: string }) {
  if (!useSettled(true, 3000)) return null;
  return (
    <div className="empty">
      <span className="live-text">loading {what}</span>
    </div>
  );
}

/** a drag nobody starts: a pane on a phone's screen is not resized */
const NO_DRAG = () => {};
/** one empty chat for the selector, so a worktree with no chat yet does not make a new array a render */
const NO_CHAT: ChatItem[] = [];

/** the two forms a file that renders is read in: the page it draws, or its text. Both seats stay
 * in the head, so the one it is on is seen and not worked out from what the other offers. */
const FORMS: TabItem<"preview" | "code">[] = [
  { id: "preview", label: "preview", tip: tip("Preview: read it rendered") },
  { id: "code", label: "code", tip: tip("Code: read and edit the text") },
];

/** the file's name first and its directory after, as the row in the changes panel has it: the name
 * is what the head is there to say, so it never shrinks, and the directory gives way when the
 * head is narrow. `note` qualifies the name (a commit's copy, last turn's) and stays with it. A
 * `title` stands in for the name and the directory both, with the path as the tip: the
 * worktree's plan is read by what it is called, not by the numbered file it sits in. */
function EditorTitle({
  path,
  note,
  title,
  worktreeId,
}: {
  path: string;
  note?: string;
  title?: string;
  /** the worktree the file is in, whose chat a drag of the name lands in as the file's mention; a
   * loose file has none, and does not drag */
  worktreeId?: string;
}) {
  const store = useStoreInstance();
  const carries = useCarries();
  const split = splitPath(path);
  const name = title ?? split.name;
  const dir = title ? "" : split.dir;
  return (
    <span
      className="editor-title"
      data-tip={dir || title ? path : undefined}
      draggable={carries && !!worktreeId}
      onDragStart={
        worktreeId ? (e) => startCarry(e, { kind: "paths", worktreeId, items: [{ path, folder: false }] }) : undefined
      }
      onDragEnd={worktreeId ? () => endCarry(store) : undefined}
    >
      <span className="editor-name">
        {name}
        {note}
      </span>
      {dir && <span className="editor-dir row-dim">{dir}</span>}
    </span>
  );
}

/** the editor pane: the open file as its diff against main or on its own, with autosave, line-hover → preview highlight.
 * On a phone's `screen` it is the whole column, read-only and not resizable: the phone steers the
 * agents and does not hand-edit files, and an on-screen keyboard over Monaco is not the place to
 * find that out. */
export function EditorPane({
  editor,
  height,
  full = false,
  onToggleFull,
  onDragStart,
  placement = "stack",
  headIn,
}: {
  editor: EditorFile;
  height?: number | string;
  full?: boolean;
  onToggleFull?: () => void;
  onDragStart?: (e: React.PointerEvent) => void;
  placement?: "stack" | "screen";
  /** where the head is drawn when it is not the pane's first row (Pane, `headIn`) */
  headIn?: HTMLElement | null;
}) {
  const onScreen = placement === "screen";
  const dispatch = useDispatch();
  const store = useStoreInstance();
  const sock = useSock();
  const urls = useUrls();
  const files = useFileSync();
  const theme = useTheme();
  const { worktreeId, path, ref, since } = editor;
  // a file from outside every worktree, dropped on the centre: `path` is its name, the text came
  // with it, and the browser saves it through the handle it carried, if one did. None of the
  // working-tree wiring below applies, and the worktree id is only lent to the pane's plumbing.
  const loose = editor.loose;
  // the remarks on the worktree's PR: a page of Toyon's own, with no text, views or lines of a file
  const prPage = loose?.source.kind === "pr-comments";
  // a file on an archived worktree's page is only in git: its directory is gone
  const kept = useStore((s) => archivedPageOf(s)?.id === worktreeId);
  const wtPath = useStore((s) => {
    const w = worktreeById(s, worktreeId)?.worktree;
    return w ? w.path : archivedPageOf(s)?.path;
  });
  // a commit's copy: read-only, and none of the working-tree wiring below applies to it
  const history = ref !== undefined;
  // the pieces list drawn at the head of the plan open here: the list names its file (the page
  // Toyon wrote, or the plan card's file once the card came), and a held list with no card yet
  // sits on the worktree's plan. Read as one item off the store rather than the whole chat, so a
  // streaming reply does not redraw the pane a delta at a time.
  const planPath = useStore((s) => worktreeById(s, worktreeId)?.worktree.plan);
  // the worktree's own plan is titled by its heading, as the line under the box names it
  const ownPlan = !loose && !history && planPath === path;
  const planTitle = usePlanTitle(ownPlan ? worktreeId : undefined, ownPlan ? path : undefined);
  // the list by the file it sits on, not the newest: a second list's page leaves the first its
  // track, since the worktrees the first made are still read from there
  const open = useStore((s) => handoffOn(localOf(s, worktreeId).chat ?? NO_CHAT, path, planPath));
  const pieces = history || loose || editor.view !== "preview" ? null : open;
  // the tab open in the head, with a list on the page: the pane's own state, so a sibling's dot
  // or age changing redraws no tab. It starts over with a new list or file, and until a tab is
  // pressed it is the page's own default (chat/handoff.ts), which on the list page moves to the
  // here piece as go is pressed: the press is the person's, and that piece is what the page is
  // for once answered.
  const [tab, setTab] = useState<string | null>(null);
  useOnChange([pieces?.id, path], () => setTab(null));
  // an open that names a piece lands on its tab, once per open: the card lists the pieces and a
  // press on one is a press on its tab. After the reset above, so a new file opened on a piece
  // keeps the piece.
  useOnChange([editor.seq], () => {
    if (editor.piece) setTab(editor.piece);
  });
  // the page Toyon wrote for a list holds each piece's text under its heading, which the tabs
  // already show: no tab for the page itself, or every text would read twice
  const hasPlan = !!pieces && !listPage(pieces);
  const current = !pieces
    ? "plan"
    : tab !== null && (tab === "plan" ? hasPlan : pieces.pieces.some((p) => p.id === tab))
      ? tab
      : defaultTab(pieces, hasPlan);
  const openPiece = pieces && current !== "plan" ? (pieces.pieces.find((p) => p.id === current) ?? null) : null;
  // the head names the plan by its title, so its pill under it is only "Plan"
  // nothing for a list of one with no plan of its own: there is nothing to switch to, and the
  // piece is the page
  const tabs = usePieceTabs(pieces, hasPlan ? "Plan" : null, current, setTab);
  const sync = useMemo(
    () =>
      loose
        ? looseSync(
            loose.source,
            path,
            (message) => dispatch({ a: "editor-refused", file: { worktreeId, path }, message }),
            browserEnv(sock ? (m) => sock.send(m) : null),
          )
        : (files?.bind({ worktreeId, path, ...(ref ? { ref } : {}), ...(since ? { since } : {}) }) ?? NO_SYNC),
    [files, worktreeId, path, ref, since, loose, dispatch, sock],
  );
  const cached = useStore((s) => localOf(s, worktreeId).changedRanges[path]);
  // warm the line-offset/ranges cache so line-hover highlights align; a tree state that moves
  // HEAD or this file's own entry drops the cache, so `cached` is a dependency and the request
  // re-fires. Ranges are measured against the working tree, so for a commit they would light up
  // lines the page never rendered.
  useEffect(() => {
    if (!cached && !history && !kept && !loose) sock?.send({ t: "changed-ranges", worktreeId, path });
  }, [worktreeId, path, cached, history, kept, loose, sock]);
  const lineOff = cached?.offset ?? 0;
  const disk = editor.disk;
  const rendering = renderedAs(path);
  // until the first read decides, the head shows what a changed file opens as: a markdown file
  // as its page, anything else as the diff of its text
  const view = editor.view ?? (rendering === "markdown" ? "preview" : "diff");
  // a file with nothing on the other side, or the same on both, has no diff to turn on; the
  // disk is read again after every save, so an edit brings the switch back. A loose file has no
  // other side at all.
  const noDiff = !!disk && (disk.before === "" || disk.before === disk.after);
  // a file the browser draws is drawn from the working tree, or from its grant when it was opened
  // from outside; one only in git (a commit's copy, an archived page) or dropped in from the
  // browser has no bytes the daemon can serve
  const grant = loose?.source.kind === "grant" ? loose.source : null;
  const viewer = history || kept || (loose && !grant) ? null : viewerOf(path);
  // a picture at the window's size: the header's button and the picture itself both open it, so
  // the pane holds the switch and the viewer draws the float. An svg read rendered is a picture
  // too, drawn from the text, so a commit's copy has one as well
  const [fullSize, setFullSize] = useState(false);
  const picture =
    viewer === "image" || (view === "preview" && rendering === "svg" && !!disk && !disk.binary && !disk.tooLarge);
  const [wrap, setWrap] = useWrap();
  // the toggle is for text in Monaco: a picture, a rendered preview and a file not shown have no lines to fold
  const wrappable = !!disk && !prPage && !viewer && !disk.binary && !disk.tooLarge && view !== "preview";
  // a markdown file with another side, read rendered, can show on the page what came and went:
  // its diff as the page it draws. A piece of the plan's list is not the file's text.
  const markable =
    view === "preview" &&
    rendering === "markdown" &&
    !!disk &&
    !prPage &&
    !viewer &&
    !disk.binary &&
    !disk.tooLarge &&
    !noDiff &&
    !openPiece;
  const marks = markable && editor.marks;
  // text the pane can show: not the PR's page, a picture in its viewer, or a file it will not open
  const shown = !prPage && !viewer && !(disk && (disk.binary || disk.tooLarge));
  // the page or its text, for a file that renders
  const forms = shown && !!rendering;
  // the diff is one answer in both forms: the text against its other side, or the page with what
  // came and went marked on it. A page that cannot be marked (html, a picture drawn from text)
  // has its diff in its text alone, so the seats wait there.
  const diffable = shown && !loose && !noDiff && (view !== "preview" || markable);
  const diffOn = view === "preview" ? marks : view === "diff";
  const onDiff = (on: boolean) =>
    dispatch(view === "preview" ? { a: "editor-marks", v: on } : { a: "editor-view", v: on ? "diff" : "file" });
  // a press on a seat changes the form and keeps the diff's answer: a marked page is left for
  // the diff of its text and a clean one for the file, and the same on the way back. A page that
  // cannot be marked is left for its diff where it has one, since its text is where that is read.
  const onForm = (form: "preview" | "code") => {
    if (form === (view === "preview" ? "preview" : "code")) return;
    if (form === "preview") dispatch({ a: "editor-view", v: "preview", marks: view === "diff" });
    else dispatch({ a: "editor-view", v: noDiff || loose || (markable && !marks) ? "file" : "diff" });
  };
  const [split, setSplit] = useSplit();
  const bodyRef = useRef<HTMLDivElement>(null);
  // the page folds to one column where Monaco folds its own, by the same number
  const roomy = useAtLeast(bodyRef, SPLIT_MIN);
  // whether the split shut the chat dock for its room: the chat comes back when the split is
  // turned off or the pane closes, and only then. A chat the person opened again meanwhile is
  // theirs to keep, and one they shut themselves is not the split's to reopen.
  const tookChat = useRef(false);
  const chatOpen = useStore((s) => s.layout.chat);
  useOnChange([chatOpen], () => {
    if (chatOpen) tookChat.current = false;
  });
  const giveChatBack = useCallback(() => {
    if (!tookChat.current) return;
    tookChat.current = false;
    const s = store.getState();
    // shown rather than toggled: this is the split's bookkeeping, not a hand asking for a panel
    if (!s.layout.chat && !isChatCentred(s)) dispatch({ a: "show-chat" });
  }, [store, dispatch]);
  const onSplit = (on: boolean) => {
    setSplit(on);
    if (!on) {
      giveChatBack();
      return;
    }
    // two columns need the room the chat has: shut it when the pane is too narrow for both, and
    // only then, so a wide window keeps the chat beside the split
    const s = store.getState();
    const width = bodyRef.current?.clientWidth ?? Number.POSITIVE_INFINITY;
    // (in zen the file has the window, and the chat is not what the columns are short of)
    if (s.layout.chat && !isChatCentred(s) && !zenShowsFile(s) && width < SPLIT_MIN) {
      tookChat.current = true;
      dispatch({ a: "toggle-chat" });
    }
  };
  // the pane closing takes the split's reason with it
  useEffect(() => giveChatBack, [giveChatBack]);
  // a layout asked for is a diff asked for; with the diff off nothing is split, so the chat a
  // split took comes back, and the layout last picked is kept for the next diff
  const onDiffSeat = (seat: DiffSeat) => {
    if (seat === "file") {
      onDiff(false);
      giveChatBack();
      return;
    }
    if (!diffOn) onDiff(true);
    onSplit(seat === "split");
  };
  // a line the page reported is only placed once its offset is known
  const line = editor.line && !editor.line.fiber ? editor.line.n : undefined;
  // an html page on the working tree can be run as well as read: the rendered view keeps its
  // scripts off, so what a script draws is seen in the preview, while this worktree's is up. A
  // phone's screen has no preview beside the file to send it to.
  const live = useStore((s) => routeTarget(s)?.worktreeId === worktreeId);
  const zenFile = useStore(zenShowsFile);
  const runnable = live && !onScreen && !history && !kept && !loose && rendering === "html";
  const runPage = () => {
    previewBus.post(worktreeId, { type: "navigate", path: servedPath(path) });
    // a full pane covers the preview the page just went to, and so does a file zen gave the
    // window to, which hands it over to the page
    if (zenShowsFile(store.getState())) dispatch({ a: "zen-page" });
    else if (full) onToggleFull?.();
  };
  return (
    // full mode takes whatever the terminal pane leaves rather than a fixed 100%
    <Pane
      kind="editor"
      className={cx("editor-pane", full && "full")}
      height={full || onScreen ? undefined : height}
      resizable={!full && !onScreen}
      onDragStart={onDragStart ?? NO_DRAG}
      title={
        <EditorTitle
          path={path}
          note={history ? ` at ${ref?.slice(0, 7)}` : since ? ", last turn" : undefined}
          title={ownPlan && planTitle ? planTitle : undefined}
          worktreeId={loose ? undefined : worktreeId}
        />
      }
      // the header names the file, so it answers with the file's actions, the same list its row in
      // the changes panel has; a commit's copy is read-only, so no discard. A loose file has no
      // row and no place in the worktree, so nothing to offer
      menu={() =>
        wtPath && !loose
          ? fileItems(
              { id: worktreeId, dir: wtPath },
              path,
              { discard: !history && !kept, kept, ref, showing: editor.view ?? undefined, noDiff },
              { sock, dispatch },
            )
          : []
      }
      // the file zen gave the window to is left by leaving zen: a cross beside that toggle was two
      // controls for one way out, so the head draws the toggle alone
      onClose={zenFile ? undefined : () => dispatch({ a: "close-editor" })}
      headIn={headIn}
      full={full}
      // a screen is already the column, so it has no split to go back to
      onToggleFull={onScreen ? undefined : onToggleFull}
      // the head holds what is about the text in sight: which view, and whether lines fold. What is
      // about where the file sits (copy its path, reveal it) is the header's right-click menu, the
      // same list the file's row in the changes panel has
      actions={
        <>
          {/* a toolbar switch, chosen once and left, so it takes an icon's room and no word. First,
              because it comes and goes with the form: the head is set from its end, so what leads
              it can leave without moving a control after it, and lit, its seat stands the head's
              gap from the strip beside it, as the strips do from each other */}
          {wrappable && (
            <IconButton
              icon="wrap"
              tone="chrome"
              on={wrap}
              aria-pressed={wrap}
              label="Wrap lines: fold a long line at the pane's edge"
              onClick={() => setWrap(!wrap)}
            />
          )}
          {forms && (
            <span className="editor-pair">
              <Tabs
                items={FORMS}
                current={view === "preview" ? "preview" : "code"}
                onPick={onForm}
                segmented
                dense
                font="mono"
                label="the page or its text"
                owner="pane"
              />
            </span>
          )}
          {/* a picture sits where a text file's views do: the pane is a strip of the window, and a
              screenshot is read at its own size */}
          {picture && (
            <Button
              variant="outline"
              tone="quiet"
              mono
              className="deep-link"
              onClick={() => setFullSize(true)}
              data-tip="Full size: see the picture over the window"
            >
              <Icon name="zen" className="icon-inline" /> full size
            </Button>
          )}
          {/* a phone's screen is one column wide whatever is asked */}
          {diffable && (
            <DiffSeats
              at={diffOn ? (split && !onScreen ? "split" : "inline") : "file"}
              onPick={onDiffSeat}
              columns={!onScreen}
            />
          )}
          {/* not a view of the text, so outside the cluster: it sends the page to the preview */}
          {runnable && (
            <Button
              variant="outline"
              tone="quiet"
              mono
              className="deep-link"
              onClick={runPage}
              data-tip="Run: open the page in the preview, with its scripts on"
            >
              <Icon name="run" className="icon-inline" /> run
            </Button>
          )}
          {/* in the close's seat, where zen left no bar: the title strip holds the head and keeps
              its own toggle after it, and a browser tab has neither */}
          {zenFile && !headIn && <ZenToggle />}
        </>
      }
    >
      {disk && <EditorNote editor={editor} disk={disk} files={files} />}
      {/* what the plan hands off, under the head that names the file, holding still while the
          text scrolls */}
      {tabs && <HandoffTrack tabs={tabs} />}
      <div className="editor-body" ref={bodyRef}>
        {prPage ? (
          <PrCommentsPage worktreeId={worktreeId} openSeq={editor.seq} focus={editor.focus} />
        ) : !disk ? (
          <Loading key={path} what={path} />
        ) : viewer ? (
          <FileViewer
            kind={viewer}
            src={grant ? urls.loose(grant.id, grant.version) : urls.worktreeFile(worktreeId, path, disk.version)}
            path={path}
            openSeq={editor.seq}
            focus={editor.focus}
            full={fullSize}
            onFull={setFullSize}
          />
        ) : disk.binary ? (
          <div className="empty">not a text file: open it in another editor</div>
        ) : disk.tooLarge ? (
          <div className="empty">too large to open here: open it in another editor</div>
        ) : view === "preview" && pieces && openPiece ? (
          <PiecePage
            item={pieces}
            piece={openPiece}
            alone={!tabs}
            worktreeId={worktreeId}
            path={path}
            version={history || kept || loose ? undefined : disk.version}
            openSeq={editor.seq}
            focus={editor.focus}
            onChat={(selected) => addToChat(store, { worktreeId, text: selected, name: path })}
          />
        ) : view === "preview" && rendering === "svg" ? (
          <SvgPreview
            text={disk.after}
            path={path}
            openSeq={editor.seq}
            focus={editor.focus}
            full={fullSize}
            onFull={setFullSize}
          />
        ) : view === "preview" && rendering === "html" ? (
          <HtmlPreview
            // the file on disk when there is one, so the files beside it draw: a copy only git
            // holds, or a file from outside with nothing of the daemon's behind it, goes as text
            source={
              grant
                ? { kind: "loose", grantId: grant.id }
                : history || kept || loose
                  ? { kind: "text", text: disk.after }
                  : { kind: "worktree", worktreeId, path }
            }
            path={path}
            version={disk.version}
            openSeq={editor.seq}
            focus={editor.focus}
          />
        ) : view === "preview" ? (
          <MarkdownPreview
            text={disk.after}
            before={markable ? disk.before : undefined}
            marks={marks}
            split={split && roomy && !onScreen}
            path={path}
            worktreeId={worktreeId}
            // a copy only git holds, or a file from outside, has no bytes on disk for its images to be served from
            version={history || kept || loose ? undefined : disk.version}
            openSeq={editor.seq}
            focus={editor.focus}
            onChat={(selected) => addToChat(store, { worktreeId, text: selected, name: path })}
          />
        ) : (
          <ErrorBoundary pane>
            <Suspense fallback={<Loading what={view} />}>
              <Editor
                // one mount per file: the models it holds are that file's, and a loose file named
                // like a worktree file is another file
                key={`${worktreeId}\n${loose ? "loose" : (ref ?? since ?? "")}\n${path}`}
                file={{ worktreeId, path, ...(ref ? { ref } : {}), ...(since ? { since } : {}) }}
                disk={disk}
                blame={editor.blame}
                view={view}
                openSeq={editor.seq}
                line={line}
                focus={editor.focus}
                readOnly={history || !disk.writable || onScreen}
                numbers={!onScreen}
                wrap={wrap}
                split={split}
                theme={theme}
                sync={sync}
                // the editor knows the lines; whose file they are, and at which commit, is the
                // pane's. A loose file's lines name no file the agent could read, so a copy is
                // plain text and a selection joins the chat under the name alone
                onCopy={
                  loose
                    ? undefined
                    : (copied, lines, clipboard) =>
                        writeCopiedSource(clipboard, {
                          worktreeId,
                          path: copied,
                          ...lines,
                          ...(ref ? { ref } : {}),
                        })
                }
                onChat={(taken, selection) =>
                  addToChat(
                    store,
                    selection &&
                      (loose
                        ? { worktreeId, text: selection.text, name: taken }
                        : {
                            worktreeId,
                            text: selection.text,
                            source: {
                              path: taken,
                              startLine: selection.startLine,
                              endLine: selection.endLine,
                              ...(ref ? { ref } : {}),
                            },
                          }),
                  )
                }
                onNew={() => store.dispatch({ a: "open-draft" })}
                onLineHover={
                  history || loose
                    ? undefined
                    : (hovered) => {
                        if (hovered == null) previewBus.post(worktreeId, { type: "highlight-clear" });
                        else
                          previewBus.post(worktreeId, {
                            type: "highlight-file",
                            path,
                            ranges: [[hovered + lineOff, hovered + lineOff]],
                          });
                      }
                }
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>
    </Pane>
  );
}

/** A row above the text when the text alone would mislead: the file changed on disk under unsaved
 * edits, or nothing typed here can be saved. It takes its own row rather than covering the code. */
function EditorNote({ editor, disk, files }: { editor: EditorFile; disk: EditorDisk; files: FileSync | null }) {
  const { worktreeId, path, ref, since, conflict } = editor;
  const file = { worktreeId, path, ...(ref ? { ref } : {}), ...(since ? { since } : {}) };
  if (conflict) {
    const gone = conflict.version === null;
    return (
      <div className="editor-note">
        <span className="editor-note-text">
          {gone ? "deleted on disk; your edits are not saved" : "changed on disk; your edits are not saved"}
        </span>
        <Button
          variant="outline"
          onClick={() => files?.reload(file)}
          data-tip={
            gone
              ? "Close the file; your edits go with it"
              : "Take the file as it is on disk; undo brings your edits back"
          }
        >
          {gone ? "close" : "reload"}
        </Button>
        <Button
          variant="outline"
          tone="danger"
          onClick={() => files?.keepMine(file)}
          data-tip={gone ? "Save your edits as the file again" : "Save your edits over the file on disk"}
        >
          keep mine
        </Button>
      </div>
    );
  }
  // a save the daemon refused, in its words; opening the file again reads it fresh and tries again
  if (editor.refused) {
    return (
      <div className="editor-note">
        <span className="hint">{editor.refused}</span>
      </div>
    );
  }
  // the PR's remarks are GitHub's, and the page says where they live
  if (editor.loose?.source.kind === "pr-comments") return null;
  // text out of the chat's transcript, a message another agent sent: nothing on disk to save it to
  if (editor.loose?.source.kind === "text" && !disk.writable) {
    return (
      <div className="editor-note">
        <span className="hint">read-only: the message as it was sent, kept in the chat and not in a file</span>
      </div>
    );
  }
  // a file from outside with no handle to save through: the browser gave its bytes and kept its
  // place. A picture or other binary is read-only wherever it sits, and says so below instead.
  if (editor.loose && !disk.writable && !disk.tooLarge && !disk.binary) {
    return (
      <div className="editor-note">
        <span className="hint">read-only: {path} is not in a project; drop it on a folder in files to add it</span>
      </div>
    );
  }
  // a commit's copy says which commit in the title, and a binary or oversized file says so in the body
  if (ref === undefined && !disk.writable && !disk.binary && !disk.tooLarge) {
    return (
      <div className="editor-note">
        <span className="hint">read-only: Toyon does not run this worktree</span>
      </div>
    );
  }
  return null;
}
