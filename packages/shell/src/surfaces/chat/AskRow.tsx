// The ask's row in the transcript. While the question is open it is one line saying what is being
// asked: the box holds the question itself, and in a long log this row is what says the turn is
// waiting on you. Pressing it brings a parked question back into the box. Once closed, the row
// reads the answers back.

import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { CLOSED } from "./AskBox.tsx";
import { type AskItem, answerText, askLine } from "./ask.ts";

export function AskRow({ item, worktreeId }: { item: AskItem; worktreeId?: string | null }) {
  const dispatch = useDispatch();
  const sock = useSock();
  if (!item.outcome) {
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
    const { title, choices, plan } = item.ask;
    const chosen = choices.find((c) => c.id === item.choiceId);
    return (
      <div className="ask-closed">
        <div className="ask-lead">{title}</div>
        {/* each plan is its own file, so the row keeps the way back to the one it was about: on an
            archived page the read comes from the archive, under the chat's own id */}
        {plan && worktreeId && (
          <div className="ask-plan hint">
            the plan is in{" "}
            <Button
              variant="inline"
              mono
              onClick={() => openFile({ sock, dispatch }, { worktreeId, path: plan, view: "preview" })}
            >
              {plan}
            </Button>
          </div>
        )}
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
