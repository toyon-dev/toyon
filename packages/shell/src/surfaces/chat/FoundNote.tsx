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
  // the head is the word and where the directory is; the line under it says only that the box
  // below does what the offer does. What taking over gives the row is what the offer's word means.
  const note = row.locked
    ? "Toyon would be working in a directory something else is using, so taking it over waits for the lock to go."
    : "A message sent below takes over this branch.";
  return (
    <DaemonRow
      icon={row.locked ? "lock" : "branch"}
      word={row.locked ? "held" : "discovered"}
      tone="quiet"
      below={<div className="daemon-below row-dim">{note}</div>}
    >
      {/* the path in the mono the grafted row names a branch in: a code chip in the head outweighs
          the word beside it. Inside the sentence, which is what grows and keeps the offer at the
          row's far end. */}
      <span className="daemon-text">
        {row.locked && `by ${row.lockReason ?? "another tool"}, at `}
        <span className="tool-hint">{dir}</span>
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
