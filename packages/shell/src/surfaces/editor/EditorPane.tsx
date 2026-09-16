import { viewerOf } from "@toyon/shared";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { writeCopiedSource } from "../../app/copiedSource.ts";
import { previewBus } from "../../app/previewBus.ts";
import { fileItems, viewsOf } from "../../state/actions/file.ts";
import { addToChat } from "../../state/attach.ts";
import { useDispatch, useFileSync, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import type { EditorSync, FileSync } from "../../state/fileSync.ts";
import { useTheme } from "../../state/selectors.ts";
import {
  archivedPageOf,
  type EditorDisk,
  type EditorFile,
  type EditorView,
  localOf,
  worktreeById,
} from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { ErrorBoundary } from "../../ui/ErrorBoundary.tsx";
import { useSettled } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Pane } from "../../ui/Pane.tsx";
import { worktreeFileUrl } from "../../ws.ts";
import { wtDir } from "../util.ts";
import { FileViewer } from "./FileViewer.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";
import { OpenInMenu } from "./OpenInMenu.tsx";
import "./editor.css";

const Editor = lazy(() => import("./Editor.tsx"));

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

/** an editor with nothing behind it (no daemon in a test): it holds the text and saves nowhere */
const NO_SYNC: EditorSync = { attach: () => {}, edited: () => {}, saveNow: () => {} };

/** a drag nobody starts: a pane on a phone's screen is not resized */
const NO_DRAG = () => {};

const VIEW_ICONS = { diff: "diff", file: "text", preview: "book" } as const;

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
  const files = useFileSync();
  const theme = useTheme();
  const { worktreeId, path, ref } = editor;
  // a file on an archived worktree's page is only in git: its directory is gone
  const kept = useStore((s) => archivedPageOf(s)?.id === worktreeId);
  const wtPath = useStore((s) => {
    const w = worktreeById(s, worktreeId)?.worktree;
    return w ? wtDir(w) : archivedPageOf(s)?.path;
  });
  const absPath = wtPath ? `${wtPath}/${path}` : path;
  // a commit's copy: read-only, and none of the working-tree wiring below applies to it
  const history = ref !== undefined;
  const sync = useMemo(
    () => files?.bind({ worktreeId, path, ...(ref ? { ref } : {}) }) ?? NO_SYNC,
    [files, worktreeId, path, ref],
  );
  const cached = useStore((s) => localOf(s, worktreeId).changedRanges[path]);
  // warm the line-offset/ranges cache so line-hover highlights align; a git-status wipes the
  // cache, so `cached` is a dependency and the request re-fires. Ranges are measured against the
  // working tree, so for a commit they would light up lines the page never rendered.
  useEffect(() => {
    if (!cached && !history && !kept) sock?.send({ t: "changed-ranges", worktreeId, path });
  }, [worktreeId, path, cached, history, kept, sock]);
  const lineOff = cached?.offset ?? 0;
  const disk = editor.disk;
  // until the first read decides, the toggles offer what they would from a diff
  const view = editor.view ?? "diff";
  // a file with nothing on the other side has no diff to switch to
  const added = disk?.before === "";
  const others = viewsOf(path, added).filter((v) => v !== view);
  // a file the browser draws is drawn from the working tree; one only in git (a commit's copy, an
  // archived page) has no bytes to serve
  const viewer = history || kept ? null : viewerOf(path);
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
      title={history ? `${path} at ${ref?.slice(0, 7)}` : path}
      // the header names the file, so it answers with the file's actions, the same list its row in
      // the changes panel has; a commit's copy is read-only, so no discard
      menu={() =>
        wtPath
          ? fileItems(
              { id: worktreeId, dir: wtPath },
              path,
              { discard: !history && !kept, kept, ref, showing: editor.view ?? undefined, added },
              { sock, dispatch },
            )
          : []
      }
      onClose={() => dispatch({ a: "close-editor" })}
      full={full}
      // a screen is already the column, so it has no split to go back to
      onToggleFull={onScreen ? undefined : onToggleFull}
      actions={
        <>
          {/* each names the view it switches to, as the full toggle beside them does */}
          {!viewer &&
            others.map((v) => (
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
          {!kept && <OpenInMenu absPath={absPath} onReveal={() => sock?.send({ t: "reveal", worktreeId, path })} />}
        </>
      }
    >
      {disk && <EditorNote editor={editor} disk={disk} files={files} />}
      <div className="editor-body">
        {!disk ? (
          <Loading key={path} what={path} />
        ) : viewer ? (
          <FileViewer
            kind={viewer}
            src={worktreeFileUrl(worktreeId, path, disk.version)}
            path={path}
            openSeq={editor.seq}
            focus={editor.focus}
          />
        ) : disk.binary ? (
          <div className="empty">not a text file: open it in another editor</div>
        ) : disk.tooLarge ? (
          <div className="empty">too large to open here: open it in another editor</div>
        ) : view === "preview" ? (
          <MarkdownPreview
            text={disk.after}
            path={path}
            worktreeId={worktreeId}
            // a copy only git holds has no bytes on disk for its images to be served from
            version={history || kept ? undefined : disk.version}
            openSeq={editor.seq}
            focus={editor.focus}
          />
        ) : (
          <ErrorBoundary pane>
            <Suspense fallback={<Loading what={view} />}>
              <Editor
                // one mount per file: the models it holds are that file's
                key={`${worktreeId}\n${ref ?? ""}\n${path}`}
                file={{ worktreeId, path, ...(ref ? { ref } : {}) }}
                disk={disk}
                view={view}
                openSeq={editor.seq}
                line={line}
                focus={editor.focus}
                readOnly={history || !disk.writable || onScreen}
                theme={theme}
                sync={sync}
                // the editor knows the lines; whose file they are, and at which commit, is the pane's
                onCopy={(copied, lines, clipboard) =>
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
                    selection && {
                      worktreeId,
                      text: selection.text,
                      source: {
                        path: taken,
                        startLine: selection.startLine,
                        endLine: selection.endLine,
                        ...(ref ? { ref } : {}),
                      },
                    },
                  )
                }
                onLineHover={
                  history
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
  const { worktreeId, path, ref, conflict } = editor;
  const file = { worktreeId, path, ...(ref ? { ref } : {}) };
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
