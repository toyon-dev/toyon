import { isMain, type LogLine, type OwnedWorktree, type ProcState } from "@toyon/shared";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { View } from "../../ui/View.tsx";
import { procFixPrompt } from "./fixPrompt.ts";

/** how much of the tail the pane shows: enough to read a stack trace, not a scrollback */
const TAIL = 30;

/** What stands in for the preview until a dev server answers: each proc with its state and, when
 * the supervisor has worked out what is wrong, the reason and a restart, over the output tail. The
 * proxy's own placeholder could not tell compiling from crashed from listening somewhere else, and
 * that was the difference between "it is coming" and "nothing will ever come". */
export function Boot({ worktree, log }: { worktree: OwnedWorktree; log: LogLine[] }) {
  const sock = useSock();
  const dispatch = useDispatch();
  const procs = worktree.procs;
  const restart = (p: ProcState) => sock?.send({ t: "term-restart", worktreeId: worktree.id, stream: p.name });
  const bad = procs.some((p) => p.status === "crashed" || p.status === "unreachable");
  const clientId = useStore((s) => s.clientId);
  // the diagnosis is specific enough to hand over: the agent gets it, the command, the tail and
  // the rule, and the daemon restarts the proc when its turn ends. Main has no agent, so its fix is
  // a worktree of its own, whose procs start from the same broken command.
  const askAgent = () => {
    const prompt = procFixPrompt(worktree, log);
    if (isMain(worktree.worktree)) sock?.send({ t: "create-worktree", clientId, repoId: worktree.repoId, prompt });
    else sock?.send({ t: "chat", worktreeId: worktree.id, text: prompt });
  };
  return (
    <View wide>
      {procs.length === 0 ? (
        <div className="status-line">starting dev servers…</div>
      ) : (
        <ul className="boot-procs">
          {procs.map((p) => (
            <li
              key={p.name}
              className={cx("boot-proc", (p.status === "crashed" || p.status === "unreachable") && "boot-bad")}
            >
              <span className="boot-name">{p.name}</span>
              <span className="boot-status">{statusText(p)}</span>
              {(p.status === "crashed" || p.status === "unreachable") && (
                <Button variant="outline" onClick={() => restart(p)}>
                  restart
                </Button>
              )}
              {p.detail && <div className="boot-detail">{p.detail}</div>}
            </li>
          ))}
        </ul>
      )}
      {bad && (
        <div className="status-actions">
          {worktree.agent === "idle" && (
            <Button variant="outline" size="lg" onClick={askAgent}>
              ask the agent to fix it
            </Button>
          )}
          {/* the way back to the command, for the person who can see what is wrong with it: the
              same page the palette's "set up" opens, which nobody reading a crash log knows about */}
          <Button onClick={() => dispatch({ a: "open", overlay: { kind: "setup", repoId: worktree.repoId } })}>
            edit setup
          </Button>
        </div>
      )}
      {log.length > 0 && (
        <pre className="status-tail">
          {log
            .slice(-TAIL)
            .map((l) => `[${l.proc}] ${l.line}`)
            .join("\n")}
        </pre>
      )}
    </View>
  );
}

function statusText(p: ProcState): string {
  switch (p.status) {
    case "starting":
      return `starting on :${p.port}`;
    case "running":
      return `running on :${p.boundPort ?? p.port}`;
    case "unreachable":
      return "never answered";
    case "crashed":
      return p.exitCode != null ? `crashed (exit ${p.exitCode})` : "crashed";
    case "stopped":
      return "stopped";
  }
}
