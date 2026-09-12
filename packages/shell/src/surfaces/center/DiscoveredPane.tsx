import type { WorktreeStatus } from "@toyon/shared";
import { useSock, useStore } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";

/** What fills the centre for a worktree git knows about but toyon does not run. There is
 * no preview to show: nothing is serving. The same slot the setup pane uses, for the same reason
 * — the centre is where a repo explains itself when it has no app to display yet. */
export function DiscoveredPane({ row }: { row: WorktreeStatus }) {
  const sock = useSock();
  const clientId = useStore((s) => s.clientId);
  const home = useStore((s) => s.home);
  const dir = home && row.path.startsWith(`${home}/`) ? `~${row.path.slice(home.length)}` : row.path;

  return (
    <div className="setup-pane">
      <p className="setup-lead">{row.name}</p>
      <div className="setup-card">
        <p>
          This worktree exists in git, but toyon did not make it and is not running it: no dev servers, no preview, no
          agent. A shell at <code>{dir}</code> opens below.
        </p>
        {row.locked ? (
          <p>
            Another tool is holding it{row.lockReason ? `: ${row.lockReason}` : ""}. Taking it over would put toyon's
            dev servers in a directory something else is working in, so that stays off until the lock goes.
          </p>
        ) : (
          <>
            <p>
              Taking it over gives it a port, starts the processes from <code>toyon.json</code> and lists it with your
              other worktrees. Your files are left alone: the install and setup commands do not re-run.
            </p>
            <div className="form-actions">
              <span className="form-dest">{dir}</span>
              <Button
                variant="outline"
                size="lg"
                onClick={() => sock?.send({ t: "adopt-worktree", worktreeId: row.id, clientId })}
              >
                take over
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
