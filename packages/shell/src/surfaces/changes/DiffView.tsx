import { lazy, Suspense, useEffect } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useTheme } from "../../state/selectors.ts";
import { localOf, type State, worktreeById } from "../../state/store.ts";
import { Pane } from "../../ui/Pane.tsx";
import { OpenInMenu } from "./OpenInMenu.tsx";

const MonacoDiff = lazy(() => import("./MonacoDiff.tsx"));

/** the editor pane: Monaco diff vs main with autosave, line-hover → preview highlight */
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
  const wtPath = useStore((s) => worktreeById(s, diff.worktreeId)?.worktree.path);
  const absPath = wtPath ? `${wtPath}/${diff.path}` : diff.path;
  const cached = useStore((s) => localOf(s, diff.worktreeId).changedRanges[diff.path]);
  // warm the line-offset/ranges cache so line-hover highlights align; a git-status wipes the
  // cache, so `cached` is a dependency and the request re-fires
  useEffect(() => {
    if (!cached) sock?.send({ t: "changed-ranges", worktreeId: diff.worktreeId, path: diff.path });
  }, [diff.worktreeId, diff.path, cached, sock]);
  const lineOff = cached?.offset ?? 0;
  return (
    // full mode takes whatever the terminal pane leaves rather than a fixed 100%
    <Pane
      className={`diff-pane ${full ? "full" : ""}`}
      height={full ? undefined : height}
      resizable={!full}
      onDragStart={onDragStart}
      title={diff.path}
      onClose={() => dispatch({ a: "close-diff" })}
      actions={
        <>
          <button
            className="btn btn-outline deep-link"
            onClick={onToggleFull}
            data-tip={full ? "Split view — show the preview above" : "Full height — hide the preview"}
          >
            {full ? "◫ split" : "⬒ full"}
          </button>
          <OpenInMenu
            absPath={absPath}
            onReveal={() => sock?.send({ t: "reveal", worktreeId: diff.worktreeId, path: diff.path })}
          />
        </>
      }
    >
      <Suspense fallback={<div className="empty">loading diff…</div>}>
        <MonacoDiff
          before={diff.before}
          after={diff.after}
          path={diff.path}
          line={diff.line}
          theme={theme}
          onSave={(content) => sock?.send({ t: "write-file", worktreeId: diff.worktreeId, path: diff.path, content })}
          onLineHover={(line) => {
            if (line == null) previewBus.post(diff.worktreeId, { type: "highlight-clear" });
            else
              previewBus.post(diff.worktreeId, {
                type: "highlight-file",
                path: diff.path,
                ranges: [[line + lineOff, line + lineOff]],
              });
          }}
        />
      </Suspense>
    </Pane>
  );
}
