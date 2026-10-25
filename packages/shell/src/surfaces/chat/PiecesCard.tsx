// Toyon's own pieces card: the agent handed over the pieces of its work outside plan mode, so
// there is no plan card for the list to ride beside, and the box asks instead. One piece, which
// is most splits, is answered here whole: the text in the band where it is read, and the fates as
// the rows, the agent's proposal first so enter on an untouched card is the proposal. A list of
// several is read and moved in the document on the right, which the card opens on a press and
// never on its own: a pane that opens itself is one the person has to close, and on the phone it
// took the screen with the card behind it. A note is the plan card's note: `n` opens the field
// under the row it is on, and it is added to every piece an agent elsewhere reads.

import type { AskAnswer } from "@toyon/shared";
import { useMemo, useRef, useState } from "react";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { type Choice, Choices } from "../../ui/Choices.tsx";
import { handleChoiceKey } from "../../ui/choiceKeys.ts";
import { dropBlankNote, setNote } from "./ask.ts";
import { Card, CardBand, CardHead, type Root, takeKeyboard } from "./Card.tsx";
import { renderMarkdown } from "./markdown.ts";
import {
  effectiveFate,
  type OneRow,
  oneRows,
  type PiecesItem,
  pieceFate,
  piecesAnswer,
  piecesQuestion,
} from "./pieces.ts";

/** one slot, no pick: the note is the whole of what the card takes from the person */
const BLANK: AskAnswer[] = [{ selected: [] }];

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
  // the row the note's field is under: the pick in the draft, read as a row index
  const noted = noting ? Number(draft[0]?.selected[0] ?? 0) : -1;
  const write = (next: AskAnswer[], row = 0) =>
    dispatch({
      a: "card-draft",
      id: worktreeId,
      card: { id: item.id, draft: [{ ...(next[0] ?? { selected: [] }), selected: [String(row)] }], current: 0 },
    });
  const field = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  // go went out on this row: the daemon's go event closes the card a round trip later, and
  // until then the row pressed says so
  const [pressed, setPressed] = useState<number | null>(null);
  const starting = pressed !== null;
  const only = item.pieces.length === 1 ? item.pieces[0] : undefined;
  const plan = item.plan;
  // the page the list sits on, beside the box
  const read = () => {
    if (plan) openFile({ sock, dispatch }, { worktreeId, path: plan, view: "preview" });
  };
  const html = useMemo(() => (only ? renderMarkdown(only.brief) : ""), [only]);

  /** the rows: one piece's fates, or go and not now for a list */
  const shape: OneRow[] = useMemo(
    () =>
      only
        ? oneRows(item, only)
        : [
            { fate: "worktree", label: "go", notes: true },
            { fate: null, label: "not now", notes: false },
          ],
    [item, only],
  );

  /** the answer: a fate the agent did not propose goes first, then go, two frames the daemon
   * reads in order (the fate is recorded before go reads the list); not now closes the card */
  const answer = (row: number) => {
    if (starting || !sock) return;
    const picked = shape[row];
    if (!picked) return;
    if (picked.fate === null) {
      sock.send(piecesAnswer(item, worktreeId, false, undefined));
    } else {
      if (only && picked.fate !== effectiveFate(item, only))
        sock.send(pieceFate(item, worktreeId, only.id, picked.fate));
      sock.send(piecesAnswer(item, worktreeId, true, note));
      setPressed(row);
    }
    dispatch({ a: "answered", id: worktreeId });
  };
  /** `n`: the field opens under the cursor's row when a note means something there (an agent
   * elsewhere reads it), else under the first row that takes one; the row becomes the pick */
  const openNote = () => {
    const at = shape[cursor]?.notes ? cursor : shape.findIndex((r) => r.notes);
    if (at === -1) return;
    if (!noting || noted !== at) write(setNote(draft, 0, note ?? ""), at);
    setCursor(at);
    requestAnimationFrame(() => field.current?.focus());
  };
  const park = () => dispatch({ a: "card-park", id: worktreeId, cardId: item.id });
  const leaveField = () => {
    const next = dropBlankNote(draft, 0);
    if (next !== draft) write(next, noted);
    root.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (
      handleChoiceKey(e, {
        count: shape.length,
        cursor,
        onCursor: setCursor,
        onPick: answer,
        onEscape: park,
        onFieldEnter: () => answer(noted),
        onFieldLeave: leaveField,
      })
    )
      return;
    if (e.key === "n") {
      e.preventDefault();
      openNote();
    } else if (e.key === "r" && plan && !only) {
      e.preventDefault();
      read();
    }
  };

  const rows: Choice[] = shape.map((r, i) => ({
    label: r.label,
    ...(pressed === i ? { description: "starting" } : r.description ? { description: r.description } : {}),
    ...(r.notes ? { hint: { k: "n", label: "add context", icon: "edit", on: !noting } } : {}),
    tone: r.fate === null ? "deny" : undefined,
    checked: noting && i === noted,
    field:
      noting && i === noted
        ? {
            ref: field,
            value: note ?? "",
            placeholder: only
              ? "a note for the agent there, sent with it"
              : "a note for every piece's agent, sent with go",
            enterKeyHint: "send",
            onChange: (value) => write(setNote(draft, 0, value), noted),
            onSend: () => answer(noted),
          }
        : undefined,
    disabled: starting,
  }));

  // one piece: the question, the project it goes to when that is not this one, and the text
  // itself in the band, since the person is the one gate on what the new agent starts from
  if (only) {
    return (
      <Card root={root} id={item.id} onKeyDown={onKeyDown}>
        <CardHead
          sub={
            <>
              {only.project
                ? `Starts a worktree in ${only.project.name}, in ${item.mode} mode${item.mode === "auto" ? ", which runs without asking" : ""}, with this as its plan. `
                : ""}
              Nothing has started yet.
            </>
          }
        >
          {piecesQuestion(item)}
        </CardHead>
        <CardBand html={html} />
        <Choices
          rows={rows}
          cursor={cursor}
          onCursor={(i) => {
            setCursor(i);
            takeKeyboard(root);
          }}
          onPick={answer}
        />
      </Card>
    );
  }
  // a list: the way to it is a press, in words that say rows whose fates can be changed before go
  const open = plan ? (
    <Button variant="inline" data-tip="Open it beside the box (r)" onClick={read}>
      Read the list
    </Button>
  ) : (
    "The list is the agent's"
  );
  return (
    <Card root={root} id={item.id} onKeyDown={onKeyDown}>
      <CardHead sub={<>{open} and change any row's fate there. Nothing has started yet.</>}>
        {piecesQuestion(item)}
      </CardHead>
      <Choices
        rows={rows}
        cursor={cursor}
        onCursor={(i) => {
          setCursor(i);
          takeKeyboard(root);
        }}
        onPick={answer}
      />
    </Card>
  );
}
