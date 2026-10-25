// Toyon's own pieces card: the agent handed over the pieces of its work outside plan mode, so
// there is no plan card for the list to ride beside, and the box asks instead. The list itself is
// read and moved in the document on the right, which the card opens on a press and never on its
// own: a pane that opens itself is one the person has to close, and on the phone it took the
// screen with the card behind it. The card is the one line that says what go does, the way to the
// list, and the two presses. A note is the handoff card's note: `n` opens the field under go, and
// it is added to every brief.

import type { AskAnswer } from "@toyon/shared";
import { useRef, useState } from "react";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { type Choice, Choices } from "../../ui/Choices.tsx";
import { handleChoiceKey } from "../../ui/choiceKeys.ts";
import { dropBlankNote, setNote } from "./ask.ts";
import { Card, CardHead, type Root } from "./Card.tsx";
import { type PiecesItem, piecesAnswer, piecesQuestion } from "./pieces.ts";

/** one slot, no pick: the note is the whole of what the card takes from the person */
const BLANK: AskAnswer[] = [{ selected: [] }];

const GO = 0;
const ROWS = 2;

export function PiecesCard({
  item,
  worktreeId,
  rootRef: root,
}: {
  item: PiecesItem;
  worktreeId: string;
  rootRef: Root;
}) {
  const sock = useSock();
  const dispatch = useDispatch();
  const stored = useLocalField(worktreeId, "card");
  const draft = stored?.id === item.id ? stored.draft : BLANK;
  const note = draft[0]?.note;
  const noting = note !== undefined;
  const write = (next: AskAnswer[]) =>
    dispatch({ a: "card-draft", id: worktreeId, card: { id: item.id, draft: next, current: 0 } });
  const field = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(GO);
  // go went out: the daemon's go event closes the card a round trip later
  const [starting, setStarting] = useState(false);
  const plan = item.plan;
  // the file the list sits on, beside the box: the brief of one piece, the rows of a list
  const read = () => {
    if (plan) openFile({ sock, dispatch }, { worktreeId, path: plan, view: "preview" });
  };

  const answer = (go: boolean) => {
    if (starting || !sock) return;
    sock.send(piecesAnswer(item, worktreeId, go, note));
    if (go) setStarting(true);
    dispatch({ a: "answered", id: worktreeId });
  };
  const openNote = () => {
    if (!noting) write(setNote(draft, 0, ""));
    setCursor(GO);
    requestAnimationFrame(() => field.current?.focus());
  };
  const pick = (i: number) => answer(i === GO);
  const park = () => dispatch({ a: "card-park", id: worktreeId, cardId: item.id });
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
        onFieldEnter: () => answer(true),
        onFieldLeave: leaveField,
      })
    )
      return;
    if (e.key === "n") {
      e.preventDefault();
      openNote();
    } else if (e.key === "r" && plan) {
      e.preventDefault();
      read();
    }
  };

  const one = item.pieces.length === 1;
  const rows: Choice[] = [
    {
      label: "go",
      hint: { k: "n", label: "add context", icon: "edit", on: !noting },
      checked: noting,
      field: noting
        ? {
            ref: field,
            value: note ?? "",
            placeholder: one
              ? "a note for the agent there, sent with go"
              : "a note for every piece's agent, sent with go",
            enterKeyHint: "send",
            onChange: (value) => write(setNote(draft, 0, value)),
            onSend: () => answer(true),
          }
        : undefined,
      description: starting ? "starting" : undefined,
      disabled: starting,
    },
    { label: "not now", tone: "deny", disabled: starting },
  ];
  // the way to the list is a press, in words that say what is there: one brief, or rows whose
  // fates can be changed before go
  const open = plan ? (
    <Button variant="inline" data-tip="Open it beside the box (r)" onClick={read}>
      {one ? "Read the brief" : "Read the list"}
    </Button>
  ) : one ? (
    "The brief is the agent's"
  ) : (
    "The list is the agent's"
  );

  return (
    <Card root={root} id={item.id} onKeyDown={onKeyDown}>
      <CardHead
        sub={
          <>
            {open}
            {one ? "" : " and change any row's fate there"}. Nothing has started yet.
          </>
        }
      >
        {piecesQuestion(item)}
      </CardHead>
      <Choices rows={rows} cursor={cursor} onCursor={setCursor} onPick={pick} />
    </Card>
  );
}
