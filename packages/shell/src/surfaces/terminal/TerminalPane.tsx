import { lazy, Suspense, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useTheme } from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { chord } from "../util.ts";

const XTerm = lazy(() => import("./XTerm.tsx"));

/** the terminal pane under the preview: one shell per worktree, in its directory, kept running by
 * the daemon while the pane is hidden. Center mounts it keyed by worktree, so switching swaps the
 * shell and replays its recent output. */
export function TerminalPane({
  worktreeId,
  height,
  onDragStart,
}: {
  worktreeId: string;
  height: number;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  const dispatch = useDispatch();
  const sock = useSock();
  const theme = useTheme();
  const connected = useStore((s) => s.connected);
  const branch = useStore((s) => worktreeById(s, worktreeId)?.worktree.branch);
  // bumping the generation remounts the terminal: term-close, then term-open spawns a fresh shell
  const [gen, setGen] = useState(0);
  const [exit, setExit] = useState<number | null>(null);
  const restart = () => {
    sock?.send({ t: "term-kill", worktreeId });
    setExit(null);
    setGen((g) => g + 1);
  };
  return (
    <div className="term-pane" style={{ height }}>
      <div className="row-resize" onPointerDown={onDragStart} />
      <div className="file-head">
        <span className="file-path">{branch}</span>
        {exit !== null && <span className="term-exit">exited {exit}</span>}
        <button className="btn btn-outline" onClick={restart} {...tip("Kill the shell and start a new one")}>
          ↻ restart
        </button>
        <button onClick={() => dispatch({ a: "toggle-terminal" })} {...tip("Hide terminal", chord("terminal"))}>
          ✕
        </button>
      </div>
      <div className="term-body">
        <Suspense fallback={<div className="empty">loading terminal…</div>}>
          <XTerm
            key={gen}
            worktreeId={worktreeId}
            theme={theme}
            sock={sock}
            connected={connected}
            onAlive={(alive, code) => setExit(alive ? null : (code ?? 0))}
          />
        </Suspense>
      </div>
    </div>
  );
}
