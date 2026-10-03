import type { WorktreeStatus } from "@toyon/shared";
import { useSock, useStore } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { DaemonRow } from "./DaemonRow.tsx";

/** The one thing in a found worktree's chat: git knows the directory, Toyon did not make it and
 * runs nothing there, and this is the way in. The same row an archived chat ends on, for the same
 * reason: both are worktrees Toyon is not running, and one verb changes that. The offer lives
 * here and a message sent from the box below takes it over as well. A worktree another tool
 * holds says who has it instead, and offers nothing until the lock goes. */
export function FoundNote({ row }: { row: WorktreeStatus }) {
  const sock = useSock();
  const clientId = useStore((s) => s.clientId);
  const home = useStore((s) => s.home);
  const dir = home && row.path.startsWith(`${home}/`) ? `~${row.path.slice(home.length)}` : row.path;
  const note = row.locked
    ? "Taking it over would put Toyon's agent in a directory something else is working in, so that stays off until the lock goes."
    : "Taking it over lists it with your worktrees and gives it an agent. Your files are left alone: nothing is installed, and its preview stays off until you start it or the agent writes a file. A message sent below takes it over first.";
  return (
    <DaemonRow
      icon={row.locked ? "lock" : "branch"}
      word={row.locked ? "held" : "found"}
      tone="quiet"
      below={<div className="daemon-below row-dim">{note}</div>}
    >
      <span className="daemon-text">
        {row.locked ? `by ${row.lockReason ?? "another tool"}, at ` : "not run by Toyon, at "}
        <code>{dir}</code>
      </span>
      {!row.locked && (
        <Button
          variant="inline"
          tone="strong"
          onClick={() => sock?.send({ t: "adopt-worktree", worktreeId: row.id, clientId })}
        >
          take over
        </Button>
      )}
    </DaemonRow>
  );
}
