import type { LogLine, OwnedWorktree, ProcState } from "@toyon/shared";
import { useSock } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";

/** how much of the tail the pane shows: enough to read a stack trace, not a scrollback */
const TAIL = 30;

/** What stands in for the preview until a dev server answers: each proc with its state and, when
 * the supervisor has worked out what is wrong, the reason and a restart, over the output tail. The
 * proxy's own placeholder could not tell compiling from crashed from listening somewhere else, and
 * that was the difference between "it is coming" and "nothing will ever come". */
export function BootPane({ worktree, log }: { worktree: OwnedWorktree; log: LogLine[] }) {
  const sock = useSock();
  const procs = worktree.procs;
  const restart = (p: ProcState) => sock?.send({ t: "term-restart", worktreeId: worktree.id, stream: p.name });
  return (
    <div className="boot-pane">
      {procs.length === 0 ? (
        <div className="boot-line">starting dev servers…</div>
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
      {log.length > 0 && (
        <pre className="boot-tail">
          {log
            .slice(-TAIL)
            .map((l) => `[${l.proc}] ${l.line}`)
            .join("\n")}
        </pre>
      )}
    </div>
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
