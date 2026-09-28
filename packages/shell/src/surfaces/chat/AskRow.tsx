// The ask's quiet row in the transcript. While the question holds the box the transcript shows
// nothing for it: the box is right there with the question in full, and a row above it naming the
// same questions read as the ask said twice. Parked, the ask is out of sight, so the row is one
// line saying what is being asked, and pressing it brings the question back into the box. Closed,
// the row reads a permission's verdict back, or says why a question got no answer; a question the
// person answered is the log's own message pair, not a row here.

import { useDispatch } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { Icon } from "../../ui/Icon.tsx";
import { CLOSED } from "./AskBox.tsx";
import { type AskItem, askLine } from "./ask.ts";

export function AskRow({ item, worktreeId }: { item: AskItem; worktreeId?: string | null }) {
  const dispatch = useDispatch();
  const parked = useLocalField(worktreeId, "askParked");
  if (!item.outcome) {
    if (parked !== item.id) return null;
    return (
      <button
        type="button"
        className="row ask-row"
        onClick={() => {
          if (worktreeId) dispatch({ a: "ask-unpark", id: worktreeId });
          dispatch({ a: "focus-chat" });
        }}
      >
        <span className="ask-tag">
          <Icon name="chat" className="icon-inline" />
          asking
        </span>
        <span className="ask-row-text">{askLine(item)}</span>
      </button>
    );
  }
  const note = CLOSED[item.outcome];
  if (item.ask.kind === "permission") {
    // a plan's row reads like any other permission's: the file it was about is named at the top
    // of the composer, which does not scroll away, so the row does not say it again
    const { title, choices } = item.ask;
    const chosen = choices.find((c) => c.id === item.choiceId);
    return (
      <div className="ask-closed">
        <div className="ask-lead">{title}</div>
        <div className="ask-answered">{chosen ? chosen.name : (note ?? "closed")}</div>
      </div>
    );
  }
  return (
    <div className="ask-closed">
      <div className="ask-lead">{item.ask.message}</div>
      <div className="ask-answered">{note ?? "closed"}</div>
    </div>
  );
}
