// The ask's quiet row in the transcript, once it is closed: a permission's verdict read back, or
// why a question got no answer. An open ask has no row here. It holds the box under the log, or,
// set aside, a line at the top of that box, and a row up here as well was the ask said twice and
// in a place that scrolls away. A question the person answered is the log's own message pair, and
// a call the person let through is its own tool row.

import type { AskItem } from "./ask.ts";
import { CLOSED } from "./ask.ts";

export function AskRow({ item }: { item: AskItem }) {
  if (!item.outcome) return null;
  const note = CLOSED[item.outcome];
  if (item.ask.kind === "permission") {
    // a plan's row reads like any other permission's: the file it was about is named at the top
    // of the composer, which does not scroll away, so the row does not say it again
    const { title, choices } = item.ask;
    const chosen = choices.find((c) => c.id === item.choiceId);
    return (
      <div className="ask-closed">
        {/* the call's own row is still in the log and already names it */}
        {!item.toolId && <div className="ask-lead">{title}</div>}
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
