import type { DiscoveredWorktree } from "@toyon/shared";
import { useSock, useStore } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";

/** What fills the preview column for a worktree git knows about but toyon does not run. There is
 * no preview to show: nothing is serving. The same slot the setup pane uses, for the same reason
 * — the preview column is where a repo explains itself when it has no app to display yet. */
export function DiscoveredPane({ row }: { row: DiscoveredWorktree }) {
  const sock = useSock();
  const clientId = useStore((s) => s.clientId);
  const home = useStore((s) => s.home);
  const dir = home && row.path.startsWith(`${home}/`) ? `~${row.path.slice(home.length)}` : row.path;

  return (
    <div className="setup-pane">
      <h2>{row.name}</h2>
      <p className="setup-lead">
        This worktree exists in git, but toyon did not make it and is not running it: no dev servers, no preview, no
        agent. Its shell is open below, at <code>{dir}</code>.
      </p>
      {row.locked ? (
        <p className="setup-lead">
          Another tool is holding it{row.lockReason ? `: ${row.lockReason}` : ""}. Taking it over would put toyon's dev
          servers in a directory something else is working in, so that stays off until the lock goes.
        </p>
      ) : (
        <>
          <p className="setup-lead">
            Taking it over gives it a port, starts the processes from <code>toyon.json</code> and lists it with your
            other worktrees. Your files are left alone: the install and setup commands do not re-run.
          </p>
          <div>
            <Button
              outline
              onClick={() => sock?.send({ t: "adopt-worktree", repoId: row.repoId, path: row.path, clientId })}
            >
              take over
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
