import { type Borrowed, LOGIN_STREAM, remoteOf, runRemotes, SHELL_STREAM } from "@toyon/shared";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActive, useLocalField, useTheme } from "../../state/selectors.ts";
import { repoById, trunkOf } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { CrashCard, ErrorBoundary } from "../../ui/ErrorBoundary.tsx";
import { Pane } from "../../ui/Pane.tsx";
import { dirtyNote } from "../chips/baseNote.ts";
import { chord } from "../util.ts";
import { useTermTabs } from "./termTabs.tsx";
import "./terminal.css";

const XTerm = lazy(() => import("./XTerm.tsx"));
/** frozen empties, so a row with nothing borrowed or pointed never re-runs the effects keyed on them */
const EMPTY_BORROWED: Borrowed[] = [];
const EMPTY_POINTED: Record<string, string> = {};

/** the terminal pane under the preview: one tab per stream the worktree runs, its shell first and
 * then its dev servers. Every tab is a real pty, so a proc tab takes keystrokes the way the shell
 * does. Only the open tab streams: switching sends term-close for the old one and term-open for
 * the new, which replays that stream's own scrollback. Center mounts the pane keyed by worktree. */
export function TerminalPane({
  worktreeId,
  opened,
  height,
  onDragStart,
}: {
  worktreeId: string;
  /** the pane was asked for, rather than carried along open by a switch to this worktree */
  opened: boolean;
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
  const borrowed = active?.borrowed ?? EMPTY_BORROWED;
  const pointed = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [name, src] of Object.entries(active?.worktree.sources ?? {})) {
      const remote = remoteOf(src.at);
      if (remote !== undefined) out[name] = remote;
    }
    return Object.keys(out).length > 0 ? out : EMPTY_POINTED;
  }, [active?.worktree.sources]);
  const login = active?.login ?? false;
  // main's uncommitted files and the command's remotes, for what a borrowed or pointed tab says
  const dirty = useStore((s) => trunkOf(s, active?.repoId)?.dirty ?? 0);
  const repo = useStore((s) => repoById(s, active?.repoId));
  const stream = useLocalField(worktreeId, "termStream");
  // a `!` command from a draft's box, typed into this shell once it answers
  const run = useStore((s) => (s.termRun?.id === worktreeId && stream === SHELL_STREAM ? s.termRun.command : null));
  // the open stream has exited. A snapshot of a stream that was already dead carries no code, so
  // the card says only what it knows.
  const [exit, setExit] = useState<{ code?: number } | null>(null);
  // a proc that leaves the config (a save of the settings), one that moved to main or to a remote,
  // or a login that finished, would strand the tab on a stream nobody runs
  const main = borrowed.find((b) => b.name === stream);
  const onMain = main !== undefined;
  const remote = pointed[stream];
  useEffect(() => {
    const runs =
      stream === SHELL_STREAM ||
      (stream === LOGIN_STREAM
        ? login
        : procs.some((p) => p.name === stream) || borrowed.some((b) => b.name === stream) || stream in pointed);
    if (!runs) dispatch({ a: "term-stream", id: worktreeId, stream: SHELL_STREAM });
  }, [procs, borrowed, pointed, login, stream, worktreeId, dispatch]);
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
  const tabs = useTermTabs({ worktreeId, procs, borrowed, pointed, dirty, login, current: stream, onRestart: restart });
  // Read as the pane mounts: its first terminal takes the keyboard only if the pane was asked for.
  // Any later one, a tab picked or a restart, was asked for itself.
  const carried = useRef(!opened);
  const focusOnMount = !carried.current;
  useEffect(() => {
    carried.current = false;
  }, []);
  return (
    <Pane
      kind="terminal"
      className="term-pane"
      height={height}
      onDragStart={onDragStart}
      tabs={{ items: tabs, current: stream, onPick: pick, font: "mono", owner: "terminal", label: "terminal streams" }}
      onClose={() => dispatch({ a: "toggle-terminal" })}
      closeHint={chord("terminal")}
    >
      <div className="term-body">
        {/* nothing streams for a proc that runs on main: the body says so, where the output would be,
            with what main's state of it means here */}
        {main && (
          <CrashCard
            pane
            title={`${stream} runs on main`}
            body={[
              "Every worktree reaches main's copy until its own changes touch it, or until asked.",
              ...(dirty > 0
                ? [`${dirtyNote(dirty, stream)[0]!.toUpperCase()}${dirtyNote(dirty, stream).slice(1)}.`]
                : []),
              ...(main.status !== "running" && main.status !== "starting" && main.status !== "cold"
                ? [`Main's ${stream} is ${main.status}; every worktree reaching it is down until it is back.`]
                : []),
            ].join(" ")}
            action={
              <Button
                variant="outline"
                onClick={() => sock?.send({ t: "set-proc-source", worktreeId, name: stream, source: "here" })}
              >
                run it here
              </Button>
            }
          />
        )}
        {/* nor for one the page points at a remote: the press runs it here, its setup first */}
        {remote !== undefined && !onMain && (
          <CrashCard
            pane
            title={`${stream} points at ${remote}`}
            body={`The page here talks to ${runRemotes(repo?.config.run[stream] ?? "")[remote] ?? remote}; nothing runs here.`}
            action={
              <Button
                variant="outline"
                onClick={() => sock?.send({ t: "set-proc-source", worktreeId, name: stream, source: "here" })}
              >
                run it here
              </Button>
            }
          />
        )}
        <ErrorBoundary pane>
          <Suspense
            fallback={
              <div className="empty">
                <span className="live-text">loading terminal</span>
              </div>
            }
          >
            <XTerm
              key={`${stream}:${gen}`}
              worktreeId={worktreeId}
              stream={stream}
              theme={theme}
              sock={sock}
              connected={connected}
              focusOnMount={focusOnMount}
              focusReq={focusReq}
              onAlive={onAlive}
              run={run}
              onRan={() => dispatch({ a: "term-ran" })}
              onEscape={() => dispatch({ a: "toggle-terminal" })}
            />
          </Suspense>
        </ErrorBoundary>
      </div>
      {/* over the body rather than in place of it, so the host keeps its size and xterm's fit never
          measures an empty box; the restart is the one move, and it is where you are looking */}
      {exit !== null && !onMain && remote === undefined && (
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
