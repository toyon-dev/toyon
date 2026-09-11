import { lazy, Suspense, useEffect } from "react";
import { writeCopiedSource } from "../../app/copiedSource.ts";
import { previewBus } from "../../app/previewBus.ts";
import { fileItems } from "../../state/actions/file.ts";
import { addToChat } from "../../state/attach.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { useTheme } from "../../state/selectors.ts";
import { localOf, type State, worktreeById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { ErrorBoundary } from "../../ui/ErrorBoundary.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Pane } from "../../ui/Pane.tsx";
import { wtDir } from "../util.ts";
import { OpenInMenu } from "./OpenInMenu.tsx";
import "./editor.css";

const Editor = lazy(() => import("./Editor.tsx"));

/** the editor pane: the open file as its diff against main or on its own, with autosave, line-hover → preview highlight */
export function EditorPane({
  editor,
  height,
  full,
  onToggleFull,
  onDragStart,
}: {
  editor: NonNullable<State["editor"]>;
  height: number | string;
  full: boolean;
  onToggleFull: () => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  const dispatch = useDispatch();
  const store = useStoreInstance();
  const sock = useSock();
  const theme = useTheme();
  const wtPath = useStore((s) => {
    const w = worktreeById(s, editor.worktreeId)?.worktree;
    return w && wtDir(w);
  });
  const absPath = wtPath ? `${wtPath}/${editor.path}` : editor.path;
  // a commit's copy: read-only, and none of the working-tree wiring below applies to it
  const history = editor.ref !== undefined;
  const cached = useStore((s) => localOf(s, editor.worktreeId).changedRanges[editor.path]);
  // warm the line-offset/ranges cache so line-hover highlights align; a git-status wipes the
  // cache, so `cached` is a dependency and the request re-fires. Ranges are measured against the
  // working tree, so for a commit they would light up lines the page never rendered.
  useEffect(() => {
    if (!cached && !history) sock?.send({ t: "changed-ranges", worktreeId: editor.worktreeId, path: editor.path });
  }, [editor.worktreeId, editor.path, cached, history, sock]);
  const lineOff = cached?.offset ?? 0;
  const view = editor.view;
  const other = view === "file" ? "diff" : "file";
  return (
    // full mode takes whatever the terminal pane leaves rather than a fixed 100%
    <Pane
      className={cx("editor-pane", full && "full")}
      height={full ? undefined : height}
      resizable={!full}
      onDragStart={onDragStart}
      title={history ? `${editor.path} at ${editor.ref?.slice(0, 7)}` : editor.path}
      // the header names the file, so it answers with the file's actions, the same list its row in
      // the changes panel has; a commit's copy is read-only, so no discard
      menu={() =>
        wtPath
          ? fileItems(
              { id: editor.worktreeId, dir: wtPath },
              editor.path,
              { discard: !history, ref: editor.ref, showing: view },
              { sock, dispatch },
            )
          : []
      }
      onClose={() => dispatch({ a: "close-editor" })}
      full={full}
      onToggleFull={onToggleFull}
      actions={
        <>
          {/* names the view it switches to, as the full toggle beside it does */}
          <Button
            variant="outline"
            tone="quiet"
            mono
            className="deep-link"
            onClick={() => dispatch({ a: "editor-view", v: other })}
            data-tip={view === "file" ? "Diff view: show what changed" : "File view: hide the diff"}
          >
            <Icon name={other === "diff" ? "diff" : "text"} className="icon-inline" /> {other}
          </Button>
          <OpenInMenu
            absPath={absPath}
            onReveal={() => sock?.send({ t: "reveal", worktreeId: editor.worktreeId, path: editor.path })}
          />
        </>
      }
    >
      <div className="editor-body">
        <ErrorBoundary pane>
          <Suspense fallback={<div className="empty">loading {view}…</div>}>
            <Editor
              before={editor.before}
              after={editor.after}
              path={editor.path}
              line={editor.line}
              view={view}
              theme={theme}
              readOnly={history || !editor.writable}
              onSave={(path, content) =>
                sock?.send({
                  t: "write-file",
                  worktreeId: editor.worktreeId,
                  path,
                  content,
                  base: editor.version,
                  seq: 0,
                })
              }
              // the editor knows the lines; whose file they are, and at which commit, is the pane's
              onCopy={(path, lines, clipboard) =>
                writeCopiedSource(clipboard, {
                  worktreeId: editor.worktreeId,
                  path,
                  ...lines,
                  ...(editor.ref ? { ref: editor.ref } : {}),
                })
              }
              onChat={(path, taken) =>
                addToChat(
                  store,
                  taken && {
                    worktreeId: editor.worktreeId,
                    text: taken.text,
                    source: {
                      path,
                      startLine: taken.startLine,
                      endLine: taken.endLine,
                      ...(editor.ref ? { ref: editor.ref } : {}),
                    },
                  },
                )
              }
              onLineHover={
                history
                  ? undefined
                  : (line) => {
                      if (line == null) previewBus.post(editor.worktreeId, { type: "highlight-clear" });
                      else
                        previewBus.post(editor.worktreeId, {
                          type: "highlight-file",
                          path: editor.path,
                          ranges: [[line + lineOff, line + lineOff]],
                        });
                    }
              }
            />
          </Suspense>
        </ErrorBoundary>
      </div>
    </Pane>
  );
}
