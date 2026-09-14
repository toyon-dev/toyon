import type { ArchivedWorktree } from "@toyon/shared";
import { restoreArchived } from "../../state/actions/archive.ts";
import { useSock, useStore } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { ago } from "../util.ts";

/** how long ago, in a sentence: the gutter's "3m" and "2d" read as units here rather than as a time */
function since(at: number): string {
  const short = ago(at);
  if (short === "now") return "just now";
  const n = Number.parseInt(short, 10);
  const unit = { m: "minute", h: "hour", d: "day", w: "week", y: "year" }[short.slice(-1)] ?? "day";
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** The last thing in a removed worktree's chat: what happened to it, and the way back. It is in
 * the log's flow rather than over it, since the removal is the newest thing that happened to this
 * conversation. The restore button lives here, and a message sent from the box below restores as
 * well: a rail row that restored on its own click was too easy to hit on the way to another row,
 * and typing is not something that happens on the way past. */
export function ArchivedNote({ item }: { item: ArchivedWorktree }) {
  const sock = useSock();
  const clientId = useStore((s) => s.clientId);
  const kept = item.restorable
    ? item.uncommitted
      ? "its chat, its commits and its uncommitted changes"
      : "its chat and its commits"
    : "its chat";
  return (
    <div className="hint chat-archived">
      <p>
        This worktree was removed {since(item.archivedAt)}
        {item.landed ? ", after it was merged into main" : ""}: its directory and branch are gone, and nothing runs.
        Toyon kept {kept}.
      </p>
      {item.restorable ? (
        <>
          <p>
            Restoring checks its commits out again on the same branch, puts the uncommitted changes back over them,
            unstaged, and picks the chat up from here. The directory is new, so the install and setup commands run, and
            then the processes from the project's settings start. A message sent below restores it first.
          </p>
          <Button variant="outline" onClick={() => restoreArchived(sock, item.id, clientId)}>
            restore
          </Button>
        </>
      ) : (
        <p>
          Its commits were not kept, so there is nothing to restore. Its row's menu on the rail can delete it for good.
        </p>
      )}
    </div>
  );
}
