import { lazy, Suspense, useEffect } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { fileItems } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useTheme } from "../../state/selectors.ts";
import { localOf, type State, worktreeById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { ErrorBoundary } from "../../ui/ErrorBoundary.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Pane } from "../../ui/Pane.tsx";
import { wtDir } from "../util.ts";
import { OpenInMenu } from "./OpenInMenu.tsx";

const MonacoDiff = lazy(() => import("./MonacoDiff.tsx"));

/** the editor pane: Monaco diff vs main, or the file on its own, with autosave, line-hover → preview highlight */
export function DiffView({
  diff,
  height,
  full,
  onToggleFull,
  onDragStart,
}: {
  diff: NonNullable<State["diff"]>;
  height: number | string;
  full: boolean;
  onToggleFull: () => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  const dispatch = useDispatch();
  const sock = useSock();
  const theme = useTheme();
  const wtPath = useStore((s) => {
    const w = worktreeById(s, diff.worktreeId)?.worktree;
    return w && wtDir(w);
  });
  const absPath = wtPath ? `${wtPath}/${diff.path}` : diff.path;
  // a commit's diff: read-only, and none of the working-tree wiring below applies to it
  const history = diff.ref !== undefined;
  const cached = useStore((s) => localOf(s, diff.worktreeId).changedRanges[diff.path]);
  // warm the line-offset/ranges cache so line-hover highlights align; a git-status wipes the
  // cache, so `cached` is a dependency and the request re-fires. Ranges are measured against the
  // working tree, so for a commit they would light up lines the page never rendered.
  useEffect(() => {
    if (!cached && !history) sock?.send({ t: "changed-ranges", worktreeId: diff.worktreeId, path: diff.path });
  }, [diff.worktreeId, diff.path, cached, history, sock]);
  const lineOff = cached?.offset ?? 0;
  const view = diff.view;
  const other = view === "file" ? "diff" : "file";
  return (
    // full mode takes whatever the terminal pane leaves rather than a fixed 100%
    <Pane
      className={cx("diff-pane", full && "full")}
      height={full ? undefined : height}
      resizable={!full}
      onDragStart={onDragStart}
      title={history ? `${diff.path} at ${diff.ref?.slice(0, 7)}` : diff.path}
      // the header names the file, so it answers with the file's actions, the same list its row in
      // the changes panel has; a commit's copy is read-only, so no discard
      menu={() =>
        wtPath
          ? fileItems(
              { id: diff.worktreeId, dir: wtPath },
              diff.path,
              { discard: !history, ref: diff.ref, showing: view },
              { sock, dispatch },
            )
          : []
      }
      onClose={() => dispatch({ a: "close-diff" })}
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
            onReveal={() => sock?.send({ t: "reveal", worktreeId: diff.worktreeId, path: diff.path })}
          />
        </>
      }
    >
      <ErrorBoundary pane>
        <Suspense fallback={<div className="empty">loading {view}…</div>}>
          <MonacoDiff
            before={diff.before}
            after={diff.after}
            path={diff.path}
            line={diff.line}
            view={view}
            theme={theme}
            readOnly={history}
            onSave={(path, content) => sock?.send({ t: "write-file", worktreeId: diff.worktreeId, path, content })}
            onLineHover={
              history
                ? undefined
                : (line) => {
                    if (line == null) previewBus.post(diff.worktreeId, { type: "highlight-clear" });
                    else
                      previewBus.post(diff.worktreeId, {
                        type: "highlight-file",
                        path: diff.path,
                        ranges: [[line + lineOff, line + lineOff]],
                      });
                  }
            }
          />
        </Suspense>
      </ErrorBoundary>
    </Pane>
  );
}
