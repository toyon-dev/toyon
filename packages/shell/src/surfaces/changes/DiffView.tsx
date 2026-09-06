import { lazy, Suspense, useEffect } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocal, useTheme } from "../../state/selectors.ts";
import type { State } from "../../state/store.ts";
import { tip } from "../../ui/Tooltip.tsx";
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
  const wtPath = useStore((s) => s.worktrees.find((w) => w.worktree.id === diff.worktreeId)?.worktree.path);
  const absPath = wtPath ? `${wtPath}/${diff.path}` : diff.path;
  const cached = useLocal(diff.worktreeId).changedRanges[diff.path];
  // warm the line-offset/ranges cache so line-hover highlights align
  useEffect(() => {
    if (!cached) sock?.send({ t: "changed-ranges", worktreeId: diff.worktreeId, path: diff.path });
  }, [diff.worktreeId, diff.path]);
  const lineOff = cached?.offset ?? 0;
  return (
    <div className="diff-pane" style={{ height }}>
      {!full && <div className="row-resize" onPointerDown={onDragStart} />}
      <div className="file-head">
        <span className="file-path">{diff.path}</span>
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
        <button onClick={() => dispatch({ a: "close-diff" })} {...tip("Close", "esc")}>
          ✕
        </button>
      </div>
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
    </div>
  );
}
