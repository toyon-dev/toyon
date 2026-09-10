import { SHELL_STREAM } from "@toyon/shared";
import { lazy, Suspense, useEffect, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActive, useLocalField, useTheme } from "../../state/selectors.ts";
import { IconButton } from "../../ui/Button.tsx";
import { ErrorBoundary } from "../../ui/ErrorBoundary.tsx";
import { Pane } from "../../ui/Pane.tsx";
import { TabStrip } from "./TabStrip.tsx";
import "./terminal.css";

const XTerm = lazy(() => import("./XTerm.tsx"));

/** the terminal pane under the preview: one tab per stream the worktree runs, its shell first and
 * then its dev servers. Every tab is a real pty, so a proc tab takes keystrokes the way the shell
 * does. Only the open tab streams: switching sends term-close for the old one and term-open for
 * the new, which replays that stream's own scrollback. Center mounts the pane keyed by worktree. */
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
  const active = useActive();
  const procs = active?.procs ?? [];
  const stream = useLocalField(worktreeId, "termStream");
  const [exit, setExit] = useState<number | null>(null);
  // a proc that leaves the config (a profile switch) would strand the tab on a stream nobody runs
  useEffect(() => {
    if (stream !== SHELL_STREAM && !procs.some((p) => p.name === stream)) {
      dispatch({ a: "term-stream", id: worktreeId, stream: SHELL_STREAM });
    }
  }, [procs, stream, worktreeId, dispatch]);
  const pick = (next: string) => {
    if (next === stream) return;
    setExit(null);
    dispatch({ a: "term-stream", id: worktreeId, stream: next });
  };
  return (
    <Pane
      className="term-pane"
      height={height}
      onDragStart={onDragStart}
      title={<TabStrip worktreeId={worktreeId} procs={procs} active={stream} onPick={pick} />}
      onClose={() => dispatch({ a: "toggle-terminal" })}
      actions={
        <>
          {exit !== null && <span className="term-exit">exited {exit}</span>}
          <IconButton
            icon="reload"
            label={stream === SHELL_STREAM ? "Restart the shell" : `Restart ${stream}`}
            onClick={() => sock?.send({ t: "term-restart", worktreeId, stream })}
          />
        </>
      }
    >
      <div className="term-body">
        <ErrorBoundary pane>
          <Suspense fallback={<div className="empty">loading terminal…</div>}>
            <XTerm
              key={stream}
              worktreeId={worktreeId}
              stream={stream}
              theme={theme}
              sock={sock}
              connected={connected}
              onAlive={(alive, code) => setExit(alive ? null : (code ?? 0))}
              onEscape={() => dispatch({ a: "toggle-terminal" })}
            />
          </Suspense>
        </ErrorBoundary>
      </div>
    </Pane>
  );
}
