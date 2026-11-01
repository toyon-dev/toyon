// A message Toyon sent this chat's agent on another agent's behalf. The agent here was sent it,
// and the transcript holds it as a message, but nobody typed it, so it is not the person's bubble:
// it is a row of Toyon's own saying where it came from. The first message of a worktree born from
// a piece points the agent at the plan it was given, and the row opens that plan in the pane, the
// file this worktree owns; a piece sent into an open chat is a message with nothing on disk, and
// the row opens its text as a document out of the transcript.

import type { ReactNode } from "react";
import { nextSeq, openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import type { ChatItem } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { rowState } from "../../ui/rowState.ts";
import { DaemonRow } from "./DaemonRow.tsx";
import { WorktreeChip } from "./WorktreeChip.tsx";

export type HandedItem = Extract<ChatItem, { kind: "handed" }>;

/** a sent piece as the pane shows it: the origin agent's words, and the note under a rule */
export function handedDocument(item: Pick<HandedItem, "body" | "note">): string {
  const body = item.body ?? "";
  return item.note ? `${body.trimEnd()}\n\n---\n\nYou added: ${item.note}\n` : body;
}

export function HandedRow({
  item,
  worktreeId,
  marked,
  children,
}: {
  item: HandedItem;
  worktreeId?: string | null;
  /** the row the log marks: a search hit's */
  marked?: boolean;
  /** what the message attached, as the chips a sent message draws */
  children?: ReactNode;
}) {
  const sock = useSock();
  const dispatch = useDispatch();
  const plan = item.via === "plan";
  const open = () => {
    if (plan && item.path && worktreeId) {
      openFile({ sock, dispatch }, { worktreeId, path: item.path, view: "preview" });
      return;
    }
    dispatch({
      a: "open-loose",
      v: {
        // the pane keys on a worktree, and the chat the row is in lends its id
        worktreeId: worktreeId ?? item.origin.id,
        name: `${item.origin.title}.md`,
        text: handedDocument(item),
        binary: false,
        tooLarge: false,
        source: { kind: "text" },
        seq: nextSeq(),
      },
    });
  };
  return (
    <DaemonRow
      icon="handoff"
      word={plan ? "plan" : "piece"}
      tone="accent"
      at={item.ts}
      data-state={rowState({ cursor: marked })}
      below={[item.note ? `you added: ${item.note}` : undefined, children]}
    >
      <span className="daemon-text">
        from <WorktreeChip id={item.origin.id} title={item.origin.title} />
        {item.origin.project ? ` in ${item.origin.project}` : ""}
        {" · "}
        <Button
          variant="inline"
          data-tip={
            plan ? "Read the plan this worktree was given, beside the chat" : "Read the message beside the chat"
          }
          onClick={open}
        >
          {plan ? "the plan" : "the message"}
        </Button>
      </span>
    </DaemonRow>
  );
}
