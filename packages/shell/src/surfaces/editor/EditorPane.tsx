import { renderedAs, viewerOf } from "@toyon/shared";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { writeCopiedSource } from "../../app/copiedSource.ts";
import { previewBus } from "../../app/previewBus.ts";
import { fileItems, viewsOf } from "../../state/actions/file.ts";
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
  type EditorView,
  localOf,
  worktreeById,
} from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { ErrorBoundary } from "../../ui/ErrorBoundary.tsx";
import { useOnChange, useSettled } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Pane } from "../../ui/Pane.tsx";
import { endCarry, startCarry } from "../chat/carried.ts";
import { defaultTab, listPage, openHandoff } from "../chat/handoff.ts";
import { usePlanTitle } from "../chat/usePlanTitle.ts";
import { splitPath } from "../util.ts";
import { FileViewer } from "./FileViewer.tsx";
import { HandoffTrack, PiecePage, usePieceTabs } from "./Handoff.tsx";
import { HtmlPreview } from "./HtmlPreview.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";
import { PrCommentsPage } from "./PrCommentsPage.tsx";
import { useWrap, WrapToggle } from "./WrapToggle.tsx";
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

const VIEW_ICONS = { diff: "diff", file: "text", preview: "book" } as const;

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
  const split = splitPath(path);
  const name = title ?? split.name;
  const dir = title ? "" : split.dir;
  return (
    <span
      className="editor-title"
      data-tip={dir || title ? path : undefined}
      draggable={!!worktreeId}
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

function viewTip(to: EditorView, from: EditorView): string {
  if (to === "diff") return "Diff view: show what changed";
  if (to === "preview") return "Preview: read it rendered";
  return from === "diff" ? "File view: hide the diff" : "File view: edit the text";
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
}: {
  editor: EditorFile;
  height?: number | string;
  full?: boolean;
  onToggleFull?: () => void;
  onDragStart?: (e: React.PointerEvent) => void;
  placement?: "stack" | "screen";
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
  const open = useStore((s) => openHandoff(localOf(s, worktreeId).chat ?? NO_CHAT));
  const pieces = useMemo(() => {
    if (history || loose || editor.view !== "preview" || !open) return null;
    const on = open.plan ?? planPath;
    return on && path === on ? open : null;
  }, [history, loose, editor.view, planPath, path, open]);
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
  const planTab = useMemo(() => (hasPlan ? { label: "Plan", path } : null), [hasPlan, path]);
  // nothing for a list of one with no plan of its own: there is nothing to switch to, and the
  // piece is the page
  const tabs = usePieceTabs(pieces, planTab, current, setTab);
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
  // until the first read decides, the toggles offer what they would from a diff
  const view = editor.view ?? "diff";
  // a file with nothing on the other side, or the same on both, has no diff to switch to; the
  // disk is read again after every save, so an edit brings the view back. A loose file has no
  // other side at all.
  const noDiff = !!disk && (disk.before === "" || disk.before === disk.after);
  const others = prPage ? [] : viewsOf(path, noDiff).filter((v) => v !== view && !(loose && v === "diff"));
  // a file the browser draws is drawn from the working tree, or from its grant when it was opened
  // from outside; one only in git (a commit's copy, an archived page) or dropped in from the
  // browser has no bytes the daemon can serve
  const grant = loose?.source.kind === "grant" ? loose.source : null;
  const viewer = history || kept || (loose && !grant) ? null : viewerOf(path);
  // a picture at the window's size: the header's button and the picture itself both open it, so
  // the pane holds the switch and the viewer draws the float
  const [fullSize, setFullSize] = useState(false);
  const [wrap, setWrap] = useWrap();
  // the toggle is for text in Monaco: a picture, a rendered preview and a file not shown have no lines to fold
  const wrappable = !!disk && !prPage && !viewer && !disk.binary && !disk.tooLarge && view !== "preview";
  // a line the page reported is only placed once its offset is known
  const line = editor.line && !editor.line.fiber ? editor.line.n : undefined;
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
      onClose={() => dispatch({ a: "close-editor" })}
      full={full}
      // a screen is already the column, so it has no split to go back to
      onToggleFull={onScreen ? undefined : onToggleFull}
      // the head holds what is about the text in sight: which view, and whether lines fold. What is
      // about where the file sits (copy its path, reveal it) is the header's right-click menu, the
      // same list the file's row in the changes panel has
      actions={
        <>
          {/* each names the view it switches to, as the full toggle beside them does; a cluster,
              since they are alternatives to one another and the wrap toggle beside them is not */}
          {!viewer && others.length > 0 && (
            <span className="editor-views">
              {others.map((v) => (
                <Button
                  key={v}
                  variant="outline"
                  tone="quiet"
                  mono
                  className="deep-link"
                  onClick={() => dispatch({ a: "editor-view", v })}
                  data-tip={viewTip(v, view)}
                >
                  <Icon name={VIEW_ICONS[v]} className="icon-inline" /> {v}
                </Button>
              ))}
            </span>
          )}
          {/* a picture sits where a text file's views do: the pane is a strip of the window, and a
              screenshot is read at its own size */}
          {viewer === "image" && (
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
          {wrappable && <WrapToggle wrap={wrap} onWrap={setWrap} />}
        </>
      }
    >
      {disk && <EditorNote editor={editor} disk={disk} files={files} />}
      {/* what the plan hands off, under the head that names the file, holding still while the
          text scrolls */}
      {tabs && <HandoffTrack tabs={tabs} />}
      <div className="editor-body">
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
        ) : view === "preview" && renderedAs(path) === "html" ? (
          <HtmlPreview
            text={disk.after}
            path={path}
            worktreeId={worktreeId}
            // a copy only git holds, or a file from outside, has no bytes on disk for its assets to be served from
            version={history || kept || loose ? undefined : disk.version}
            openSeq={editor.seq}
            focus={editor.focus}
          />
        ) : view === "preview" ? (
          <MarkdownPreview
            text={disk.after}
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
