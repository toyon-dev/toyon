import { LOGIN_STREAM, SHELL_STREAM } from "@toyon/shared";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActive, useLocalField, useTheme } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { CrashCard, ErrorBoundary } from "../../ui/ErrorBoundary.tsx";
import { Pane } from "../../ui/Pane.tsx";
import { useTermTabs } from "./termTabs.tsx";
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
  const focusReq = useStore((s) => s.focusTerm);
  const active = useActive();
  const procs = active?.procs ?? [];
  const login = active?.login ?? false;
  const stream = useLocalField(worktreeId, "termStream");
  // the open stream has exited. A snapshot of a stream that was already dead carries no code, so
  // the card says only what it knows.
  const [exit, setExit] = useState<{ code?: number } | null>(null);
  // a proc that leaves the config (a profile switch), or a login that finished, would strand the
  // tab on a stream nobody runs
  useEffect(() => {
    const runs = stream === SHELL_STREAM || (stream === LOGIN_STREAM ? login : procs.some((p) => p.name === stream));
    if (!runs) dispatch({ a: "term-stream", id: worktreeId, stream: SHELL_STREAM });
  }, [procs, login, stream, worktreeId, dispatch]);
  const pick = (next: string) => {
    if (next === stream) return;
    setExit(null);
    dispatch({ a: "term-stream", id: worktreeId, stream: next });
  };
  // The daemon restarts the shell by killing it and leaves the reopen to the tab. The tab remounts
  // on the exit that follows rather than straight away: remounting at once would race the kill
  // and could snapshot the dying pty as alive. A proc is respawned under supervision on the same
  // stream, so its tab stays put and comes back with its first output.
  const reopen = useRef(false);
  const [gen, setGen] = useState(0);
  const restart = (id: string) => {
    if (id === SHELL_STREAM && id === stream) reopen.current = true;
    sock?.send({ t: "term-restart", worktreeId, stream: id });
    // the daemon starts a new login before it reads the next frame, so the tab reopens on it now
    if (id === LOGIN_STREAM && id === stream) {
      setExit(null);
      setGen((g) => g + 1);
    }
  };
  const onAlive = (alive: boolean, code?: number) => {
    if (alive) return setExit(null);
    if (reopen.current) {
      reopen.current = false;
      setGen((g) => g + 1);
      return;
    }
    setExit({ code });
  };
  const tabs = useTermTabs({ worktreeId, procs, login, onRestart: restart });
  return (
    <Pane
      className="term-pane"
      height={height}
      onDragStart={onDragStart}
      tabs={{ items: tabs, current: stream, onPick: pick, font: "mono", owner: "terminal", label: "terminal streams" }}
      onClose={() => dispatch({ a: "toggle-terminal" })}
    >
      <div className="term-body">
        <ErrorBoundary pane>
          <Suspense fallback={<div className="empty">loading terminal…</div>}>
            <XTerm
              key={`${stream}:${gen}`}
              worktreeId={worktreeId}
              stream={stream}
              theme={theme}
              sock={sock}
              connected={connected}
              focusReq={focusReq}
              onAlive={onAlive}
              onEscape={() => dispatch({ a: "toggle-terminal" })}
            />
          </Suspense>
        </ErrorBoundary>
      </div>
      {/* over the body rather than in place of it, so the host keeps its size and xterm's fit never
          measures an empty box; the restart is the one move, and it is where you are looking */}
      {exit !== null && (
        <CrashCard
          pane
          title={
            stream === SHELL_STREAM
              ? "the shell exited"
              : stream === LOGIN_STREAM
                ? "the login did not finish"
                : `${stream} exited`
          }
          body={exit.code === undefined ? undefined : `exit code ${exit.code}`}
          action={
            <Button variant="outline" onClick={() => restart(stream)}>
              restart
            </Button>
          }
        />
      )}
    </Pane>
  );
}
