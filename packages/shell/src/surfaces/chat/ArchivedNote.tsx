import type { ArchivedWorktree } from "@toyon/shared";
import { restoreArchived } from "../../state/actions/archive.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { landedLines } from "../recap.ts";
import { DaemonRow, useAgo } from "./DaemonRow.tsx";
import { dollars } from "./usage.ts";

/** The last thing in a removed worktree's chat: what happened to it, and the way back. It is in
 * the log's flow rather than over it, since the removal is the newest thing that happened to this
 * conversation, and it is the daemon's row, like the word on a land. The restore offer lives here,
 * and a message sent from the box below restores as well: a rail row that restored on its own
 * click was too easy to hit on the way to another row, and typing is not something that happens
 * on the way past. The offer goes with the press: the page stays until the row is listed, which
 * can take a while behind a landing, and a second press would ask for a second worktree. */
export function ArchivedNote({ item }: { item: ArchivedWorktree }) {
  const sock = useSock();
  const dispatch = useDispatch();
  const clientId = useStore((s) => s.clientId);
  const restoring = useLocalField(item.id, "restoring");
  // the sentence beside the word fits one line, the way the landed row's does, and the note under
  // it says only what the word does not: what was kept, and that the box below restores as well.
  // That the directory and branch are gone is what archived means; what restoring does is what
  // the offer's word means.
  const kept = item.uncommitted ? "its chat, commits and uncommitted changes" : "its chat and commits";
  const cost = item.cost !== undefined ? `; the session cost ${dollars(item.cost)}` : "";
  const note = item.restorable
    ? `Toyon kept ${kept}${cost}. A message sent below restores it first.`
    : `Its commits were not kept, so there is nothing to restore${cost}; its row's menu on the rail can delete it for good.`;
  const ago = useAgo(item.archivedAt);
  // what it landed, ahead of what was kept: the landed rows above say it too, but far up a long
  // chat, and this is the last word on it
  const landed = landedLines(item.lands);
  return (
    <DaemonRow
      icon="archive"
      word="archived"
      tone="quiet"
      at={item.archivedAt}
      below={
        <>
          {landed.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, built whole from the record
            <div key={i} className="daemon-below row-dim">
              {line}
            </div>
          ))}
          <div className="daemon-below row-dim">{note}</div>
        </>
      }
    >
      <span className="daemon-text">
        {ago}
        {item.landed ? ", after it was merged into main" : ""}
      </span>
      {item.restorable && restoring === undefined && (
        <Button variant="inline" tone="strong" onClick={() => restoreArchived({ sock, dispatch }, item.id, clientId)}>
          restore
        </Button>
      )}
    </DaemonRow>
  );
}
