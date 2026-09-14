import type { ArchivedWorktree } from "@toyon/shared";
import { restoreArchived } from "../../state/actions/archive.ts";
import { useSock, useStore } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { View } from "../../ui/View.tsx";
import { ago } from "../util.ts";

/** how long ago, in a sentence: the gutter's "3m" and "2d" read as units here rather than as a time */
function since(at: number): string {
  const short = ago(at);
  if (short === "now") return "just now";
  const n = Number.parseInt(short, 10);
  const unit = { m: "minute", h: "hour", d: "day", w: "week", y: "year" }[short.slice(-1)] ?? "day";
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** What fills the centre for a removed worktree. Nothing of it can be shown: its directory and
 * branch are gone, and its chat is with the daemon until it is restored. The same slot the found
 * worktree's page uses, for the same reason, and it is where the restore button lives: a rail row
 * that restored on its own click was too easy to hit on the way to another row. */
export function Archived({ item }: { item: ArchivedWorktree }) {
  const sock = useSock();
  const clientId = useStore((s) => s.clientId);
  const kept = item.restorable
    ? item.uncommitted
      ? "its chat, its commits and its uncommitted changes"
      : "its chat and its commits"
    : "its chat";
  return (
    <View wide>
      <p className="status-line">{item.title}</p>
      {/* the first message sent to it: what the work was, which the title only abbreviates */}
      {item.prompt && <p>{item.prompt}</p>}
      <p>
        This worktree was removed {since(item.archivedAt)}
        {item.landed ? ", after it was merged into main" : ""}: its directory and branch are gone, and nothing runs.
        Toyon kept {kept}.
      </p>
      {item.restorable ? (
        <>
          <p>
            Restoring checks its commits out again on the same branch, puts the uncommitted changes back over them,
            unstaged, and brings the chat with it. The directory is new, so the install and setup commands run, and then
            the processes from the project's settings start.
          </p>
          <div className="status-actions">
            <Button variant="outline" size="lg" onClick={() => restoreArchived(sock, item.id, clientId)}>
              restore
            </Button>
          </div>
        </>
      ) : (
        <p>
          Its commits were not kept, so there is nothing to restore. Its row's menu on the rail can delete it for good.
        </p>
      )}
    </View>
  );
}
