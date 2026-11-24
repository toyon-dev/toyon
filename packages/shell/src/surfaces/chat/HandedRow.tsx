// A message Toyon sent this chat's agent on another agent's behalf. The agent here was sent it,
// and the transcript holds it as a message, but nobody typed it, so it is not the person's bubble:
// it is a row of Toyon's own saying where it came from. The first message of a worktree born from
// a piece points the agent at the plan it was given, and the row opens that plan in the pane, the
// file this worktree owns; a piece sent into an open chat is a message with nothing on disk, and
// the row opens its text as a document out of the transcript. Toyon's own message for what became
// of the work handed off is the same row, from the chat that landed where one did.

import { Fragment, type ReactNode } from "react";
import { nextSeq, openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import type { ChatItem } from "../../state/store.ts";
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
      // a plan came with a worktree made for it, the branch that left the origin; a message made
      // none, and wears the arrow coming in, the other half of the one its row in the origin's
      // chat wears going out
      icon={plan ? "handoff" : "incoming"}
      word={plan ? "plan" : "message"}
      tone="accent"
      at={item.ts}
      data-state={rowState({ cursor: marked })}
      below={[item.note ? `you added: ${item.note}` : undefined, children]}
      // one word for both, the one every row that opens a document says: the row's own word
      // already says which was given
      press={{
        label: "details",
        tip: plan ? "Read the plan this worktree was given, beside the chat" : "Read the message beside the chat",
        onPress: open,
      }}
    >
      <span className="daemon-text">
        from <WorktreeChip id={item.origin.id} title={item.origin.title} />
        {item.origin.project ? ` in ${item.origin.project}` : ""}
      </span>
    </DaemonRow>
  );
}

/** A message Toyon sent the agent on its own, for something that gives it work to do: news of
 * what it handed off, or a failure that is its to fix. One for a landing elsewhere is from the
 * chat that landed, to the person reading: that chat reporting back, so the row names it as a
 * sent piece's row names its origin. One for an answer on Toyon's own card, a failure or a
 * worktree gone has no other chat behind it and names no sender: every row here is Toyon's,
 * and a chip for this chat would name the row the reader is in. The row
 * opens what the agent was sent, since the reply under it answers words the chat shows nowhere
 * else. */
export function NewsRow({
  item,
  worktreeId,
}: {
  item: Extract<ChatItem, { kind: "news" }>;
  worktreeId?: string | null;
}) {
  const dispatch = useDispatch();
  const from = item.from ?? [];
  return (
    <DaemonRow
      icon="incoming"
      word="message"
      tone="accent"
      at={item.ts}
      press={
        // the pane keys on a worktree: with none on screen there is nowhere to open it
        worktreeId
          ? {
              label: "details",
              tip: "Read the message beside the chat",
              onPress: () =>
                dispatch({
                  a: "open-loose",
                  v: {
                    worktreeId,
                    name: `${from[0]?.title ?? "Message"}.md`,
                    text: item.text,
                    binary: false,
                    tooLarge: false,
                    source: { kind: "text" },
                    seq: nextSeq(),
                  },
                }),
            }
          : undefined
      }
    >
      <span className="daemon-text">
        {from.length > 0 && "from "}
        {from.map((f, i) => (
          <Fragment key={f.id}>
            {i > 0 && (i === from.length - 1 ? " and " : ", ")}
            <WorktreeChip id={f.id} title={f.title} />
            {f.project ? ` in ${f.project}` : ""}
          </Fragment>
        ))}
        {from.length > 0 && ", "}
        {item.why}
      </span>
    </DaemonRow>
  );
}
