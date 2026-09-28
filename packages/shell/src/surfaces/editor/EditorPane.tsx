import { renderedAs, viewerOf } from "@toyon/shared";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { writeCopiedSource } from "../../app/copiedSource.ts";
import { previewBus } from "../../app/previewBus.ts";
import { fileItems, viewsOf } from "../../state/actions/file.ts";
import { addToChat } from "../../state/attach.ts";
import { useDispatch, useFileSync, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import type { FileSync } from "../../state/fileSync.ts";
import { browserEnv, looseSync, NO_SYNC } from "../../state/looseSync.ts";
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
import { FileViewer } from "./FileViewer.tsx";
import { HtmlPreview } from "./HtmlPreview.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";
import { OpenInMenu } from "./OpenInMenu.tsx";
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
  // a file from outside every worktree, dropped on the centre: `path` is its name, the text came
  // with it, and the browser saves it through the handle it carried, if one did. None of the
  // working-tree wiring below applies, and the worktree id is only lent to the pane's plumbing.
  const loose = editor.loose;
  // a file on an archived worktree's page is only in git: its directory is gone
  const kept = useStore((s) => archivedPageOf(s)?.id === worktreeId);
  const wtPath = useStore((s) => {
    const w = worktreeById(s, worktreeId)?.worktree;
    return w ? w.path : archivedPageOf(s)?.path;
  });
  // a granted file lives where the daemon opened it; a dropped one has no place the browser will name
  const absPath = loose
    ? loose.source.kind === "grant"
      ? loose.source.path
      : null
    : wtPath
      ? `${wtPath}/${path}`
      : path;
  // a commit's copy: read-only, and none of the working-tree wiring below applies to it
  const history = ref !== undefined;
  const sync = useMemo(
    () =>
      loose
        ? looseSync(
            loose.source,
            path,
            (message) => dispatch({ a: "editor-refused", file: { worktreeId, path }, message }),
            browserEnv(sock ? (m) => sock.send(m) : null),
          )
        : (files?.bind({ worktreeId, path, ...(ref ? { ref } : {}) }) ?? NO_SYNC),
    [files, worktreeId, path, ref, loose, dispatch, sock],
  );
  const cached = useStore((s) => localOf(s, worktreeId).changedRanges[path]);
  // warm the line-offset/ranges cache so line-hover highlights align; a git-status wipes the
  // cache, so `cached` is a dependency and the request re-fires. Ranges are measured against the
  // working tree, so for a commit they would light up lines the page never rendered.
  useEffect(() => {
    if (!cached && !history && !kept && !loose) sock?.send({ t: "changed-ranges", worktreeId, path });
  }, [worktreeId, path, cached, history, kept, loose, sock]);
  const lineOff = cached?.offset ?? 0;
  const disk = editor.disk;
  // until the first read decides, the toggles offer what they would from a diff
  const view = editor.view ?? "diff";
  // a file with nothing on the other side has no diff to switch to; a loose file has no other side
  const added = disk?.before === "";
  const others = viewsOf(path, added).filter((v) => v !== view && !(loose && v === "diff"));
  // a file the browser draws is drawn from the working tree; one only in git (a commit's copy, an
  // archived page) or from outside it has no bytes to serve
  const viewer = history || kept || loose ? null : viewerOf(path);
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
      // the changes panel has; a commit's copy is read-only, so no discard. A loose file has no
      // row and no place in the worktree, so nothing to offer
      menu={() =>
        wtPath && !loose
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
          {/* a dropped file's place on disk is the browser's secret, so there is nowhere to open it;
              a granted one is opened by its place, and the reveal is a worktree file's alone */}
          {!kept && absPath !== null && (
            <OpenInMenu
              absPath={absPath}
              onReveal={loose ? undefined : () => sock?.send({ t: "reveal", worktreeId, path })}
            />
          )}
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
                key={`${worktreeId}\n${loose ? "loose" : (ref ?? "")}\n${path}`}
                file={{ worktreeId, path, ...(ref ? { ref } : {}) }}
                disk={disk}
                blame={editor.blame}
                view={view}
                openSeq={editor.seq}
                line={line}
                focus={editor.focus}
                readOnly={history || !disk.writable || onScreen}
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
  // a file from outside with no handle to save through: the browser gave its bytes and kept its place
  if (editor.loose && !disk.writable && !disk.tooLarge) {
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
