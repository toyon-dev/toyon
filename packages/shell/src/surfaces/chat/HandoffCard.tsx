// The handoff card: a proposal to continue this work in another open project, in the composer box
// the way an ask is, because the box is where the person is looking and nothing has started until
// they say so. It asks the same shape of question a permission does: the proposal at the head, the
// message in the band, and two choices. Go makes the worktree there; not now closes the card. A
// note is the ask's note: `n` on the go row opens the field under it and makes go the pick, since
// the note is written for the agent go starts, and enter in the field is then the go. The note is
// the box's ask draft, so switching worktrees and parking keep it.

import type { AskAnswer } from "@toyon/shared";
import { useMemo, useRef, useState } from "react";
import { useDispatch, useSock } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { type Choice, Choices } from "../../ui/Choices.tsx";
import { handleChoiceKey } from "../../ui/choiceKeys.ts";
import { dropBlankNote, setNote } from "./ask.ts";
import { BoxCard, CardBand, CardHead, type Root } from "./BoxCard.tsx";
import { type HandoffItem, handoffAnswer } from "./handoff.ts";
import { renderMarkdown } from "./markdown.ts";

/** one slot, no pick: the note is the whole of what the card takes from the person */
const BLANK: AskAnswer[] = [{ selected: [] }];

/** the rows, in digit order: go first, so enter on an untouched card is the go; the refusal
 * second, in the permission card's red */
const GO = 0;
const ROWS = 2;

export function HandoffCard({
  item,
  worktreeId,
  rootRef: root,
}: {
  item: HandoffItem;
  worktreeId: string;
  rootRef: Root;
}) {
  const sock = useSock();
  const dispatch = useDispatch();
  const stored = useLocalField(worktreeId, "ask");
  const draft = stored?.id === item.id ? stored.draft : BLANK;
  // undefined is the field shut; "" is the field open with nothing typed yet
  const note = draft[0]?.note;
  const noting = note !== undefined;
  const write = (next: AskAnswer[]) =>
    dispatch({ a: "ask-draft", id: worktreeId, ask: { id: item.id, draft: next, current: 0 } });
  const field = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(GO);
  // Go went out and the daemon is making the worktree: the handoff event closes the card, or a
  // decline with the reason does, so this only holds the rows until one of them lands
  const [starting, setStarting] = useState(false);
  const html = useMemo(() => renderMarkdown(item.message), [item.message]);

  const answer = (go: boolean) => {
    if (starting || !sock) return;
    sock.send(handoffAnswer(item, worktreeId, go, note));
    if (go) setStarting(true);
    // the decision is the reader's word, so the log goes to its end as it does on a send
    dispatch({ a: "answered", id: worktreeId });
  };
  /** `n`: the note's field opens under go, which becomes the pick without moving on, since the
   * note is still to be written; the caret goes in once it is painted, the commit after this one */
  const openNote = () => {
    if (!noting) write(setNote(draft, 0, ""));
    setCursor(GO);
    requestAnimationFrame(() => field.current?.focus());
  };
  const pick = (i: number) => answer(i === GO);
  /** escape gives the plain box back and leaves the card a line at its top */
  const park = () => dispatch({ a: "ask-park", id: worktreeId, askId: item.id });
  /** back to the rows from the field, a field left blank going with it */
  const leaveField = () => {
    const next = dropBlankNote(draft, 0);
    if (next !== draft) write(next);
    root.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (
      handleChoiceKey(e, {
        count: ROWS,
        cursor,
        onCursor: setCursor,
        onPick: pick,
        onEscape: park,
        // the field sits on the go row, which `n` made the pick: enter in it is the go with the note
        onFieldEnter: () => answer(true),
        onFieldLeave: leaveField,
      })
    )
      return;
    if (e.key === "n") {
      e.preventDefault();
      openNote();
    }
  };

  const rows: Choice[] = [
    {
      label: "go",
      hint: { k: "n", label: "add context", on: !noting },
      // go with a note open on it holds the note's field and is the pick
      checked: noting,
      field: noting
        ? {
            ref: field,
            value: note ?? "",
            placeholder: "a note for the agent there, sent with go",
            enterKeyHint: "send",
            onChange: (value) => write(setNote(draft, 0, value)),
          }
        : undefined,
      description: starting ? "starting" : undefined,
      disabled: starting,
    },
    { label: "not now", tone: "deny", disabled: starting },
  ];

  return (
    <BoxCard root={root} id={item.id} onKeyDown={onKeyDown}>
      {/* where it goes and in what mode, since two open projects can share a name and the mode
          is what the new agent may do without asking: auto is said in those words, because this
          message, written by an agent, becomes that agent's first prompt with no card in
          between; and whose idea it was, since a message written by an agent is read
          differently from one the person asked for */}
      <CardHead
        sub={
          <>
            Starts a worktree in {item.repo.path}, in {item.mode} mode
            {item.mode === "auto" ? ", which runs without asking" : ""}. Nothing has started yet.{" "}
            {item.by === "agent" ? "Proposed by this worktree's agent." : "You asked for this."}
          </>
        }
      >
        Continue in {item.repo.name}?
      </CardHead>
      {/* the message whole, in the band a plan is read in: the person is the one gate on what
          another project's agent will start from, so nothing of it is folded away */}
      <CardBand html={html} />
      <Choices rows={rows} cursor={cursor} onCursor={setCursor} onPick={pick} />
    </BoxCard>
  );
}
