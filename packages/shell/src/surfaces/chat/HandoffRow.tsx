// The handoff's quiet rows in the transcript, once the card is closed: where the work went, with
// the way there, or that it did not go and why. An open proposal has no row here: it holds the box
// under the log, or, set aside, a line at the top of that box, and a row up here as well was the
// card said twice and in a place that scrolls away. The landing the other project reports back is
// a row of its own, since it comes long after.

import { useDispatch, useStore } from "../../state/context.tsx";
import type { ChatItem } from "../../state/store.ts";
import { worktreeById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { DaemonRow } from "./DaemonRow.tsx";
import type { HandoffItem } from "./handoff.ts";

export function HandoffRow({ item }: { item: HandoffItem }) {
  const dispatch = useDispatch();
  // the row made in the other project is a press away while it is still listed
  const there = useStore((s) => worktreeById(s, item.worktreeId) !== null);
  if (item.state === "proposed") return null;
  if (item.state === "declined") {
    return (
      <DaemonRow
        icon="close"
        word="not continued"
        tone="quiet"
        at={item.ts}
        below={item.reason ? <div className="daemon-below row-dim">{item.reason}</div> : undefined}
      >
        <span className="daemon-text">in {item.repo.name}</span>
      </DaemonRow>
    );
  }
  return (
    <DaemonRow icon="spawn" word="continued" tone="accent" at={item.ts}>
      <span className="daemon-text">
        in {item.repo.name}:{" "}
        <Button
          variant="inline"
          tone="strong"
          disabled={!there}
          onClick={() => item.worktreeId && dispatch({ a: "activate", id: item.worktreeId })}
        >
          {item.title ?? item.repo.name}
        </Button>
      </span>
    </DaemonRow>
  );
}

/** the other project's word that the handed-off work landed there, with its pull request when
 * the landing was one: the record of the handoff closing, read where it was opened */
export function HandoffLandedRow({ item }: { item: Extract<ChatItem, { kind: "handoff-landed" }> }) {
  return (
    <DaemonRow icon="check" word="landed" tone="aqua" at={item.ts}>
      <span className="daemon-text">
        {item.title} in {item.repoName}
      </span>
      {item.url && (
        <Button variant="inline" tone="strong" onClick={() => window.open(item.url, "_blank")}>
          view PR
        </Button>
      )}
    </DaemonRow>
  );
}
