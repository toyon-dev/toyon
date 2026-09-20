// The ask's row in the transcript. While the question holds the box the transcript shows nothing
// for it: the box is right there with the question in full, and a row above it naming the same
// questions read as the ask said twice. Parked, the ask is out of sight, so the row is one line
// saying what is being asked, and pressing it brings the question back into the box. Once closed,
// the row reads the answers back.

import { useDispatch } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { CLOSED } from "./AskBox.tsx";
import { type AskItem, answerText, askLine } from "./ask.ts";

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
        <span className="ask-tag">asking</span>
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
  const { message, questions } = item.ask;
  return (
    <div className="ask-closed">
      <div className="ask-lead">{message}</div>
      {note ? (
        <div className="ask-answered">{note}</div>
      ) : (
        questions.map((q, i) => (
          <div className="ask-answered" key={q.id}>
            {q.header && <span className="ask-header">{q.header}</span>}
            {q.header && " "}
            {answerText(q, item.answers?.[i])}
          </div>
        ))
      )}
    </div>
  );
}
