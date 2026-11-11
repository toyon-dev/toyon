// Toyon's own handoff card: the agent handed over the pieces of its work outside plan mode, so
// there is no plan card for the list to ride beside, and the box asks instead. One piece, which
// is most lists, is answered here whole: the text in the band where it is read, and the fates as
// the rows, the agent's proposal first so enter on an untouched card is the proposal. A list of
// several is read and moved in the document on the right, which opens beside the box as the card
// arrives, the way a plan does beside its card; the card does not list the pieces itself: the
// question carries the count and the page carries the rows.
//
// It is answered the way a plan card is. `n` opens a field under the cursor's row, which becomes
// the pick, and enter in the field is that pick. A letter typed on the card opens the field under
// not now with the letter in it, since words on the card are nearly always what to change. Words
// with a fate go to every agent a piece is sent to, this one's for a piece kept here; words with
// not now go to this worktree's agent, which is otherwise told nothing.

import type { AskAnswer } from "@toyon/shared";
import { useMemo, useRef, useState } from "react";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { type Choice, Choices } from "../../ui/Choices.tsx";
import { handleChoiceKey } from "../../ui/choiceKeys.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { dropBlankNote } from "./ask.ts";
import { Card, CardBand, CardHead, type Root, takeKeyboard } from "./Card.tsx";
import {
  effectiveFate,
  type HandoffItem,
  handoffAnswer,
  handoffCounts,
  handoffQuestion,
  LIST_ROWS,
  notePlaceholder,
  notNowRow,
  type OneRow,
  oneRows,
  pieceFate,
} from "./handoff.ts";
import { renderMarkdown } from "./markdown.ts";
import { typingStart } from "./permissionNote.ts";

/** one slot, no pick: the note is the whole of what the card takes from the person */
const BLANK: AskAnswer[] = [{ selected: [] }];

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
  const stored = useLocalField(worktreeId, "card");
  // the new worktree starts in this one's mode as it stands when go is pressed (a plan it is given
  // is approved by the go, so never plan mode), so the card reads the record, not the proposal
  const live = useStore((s) => worktreeById(s, worktreeId)?.worktree.mode) ?? item.mode;
  const mode = live === "plan" ? "auto" : live;
  const draft = stored?.id === item.id ? stored.draft : BLANK;
  const note = draft[0]?.note;
  const noting = note !== undefined;
  // the row the note's field is under: the pick in the draft, read as a row index
  const noted = noting ? Number(draft[0]?.selected[0] ?? 0) : -1;
  const write = (next: AskAnswer[]) =>
    dispatch({ a: "card-draft", id: worktreeId, card: { id: item.id, draft: next, current: 0 } });
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
  // The page opens as the card arrives: it is what go is asked about. Not on a phone, where the
  // pane is a cover over the whole column: it would hide the card it is about, and closing it
  // would mount the card again and open the page again. One piece's text is in the band.
  const active = useStore((s) => s.activeId);
  const phone = useStore((s) => s.frame === "phone");
  useOnChange([item.id, plan], () => {
    // the caret stays on the card, which is what is being asked
    if (plan && !only && active === worktreeId && !phone)
      openFile({ sock, dispatch }, { worktreeId, path: plan, view: "preview", focus: false });
  });
  const html = useMemo(() => (only ? renderMarkdown(only.plan) : ""), [only]);

  /** the rows: one piece's fates, or go and not now for a list */
  const shape: readonly OneRow[] = useMemo(() => (only ? oneRows(item, only) : LIST_ROWS), [item, only]);

  /** the answer: a fate the agent did not propose goes first, then go, two frames the daemon
   * reads in order (the fate is recorded before go reads the list); not now closes the card.
   * The words go with whatever was picked: typed under one row and answered by another's digit,
   * they are still what the person had to say. */
  const answer = (row: number) => {
    if (starting || !sock) return;
    const picked = shape[row];
    if (!picked) return;
    if (picked.fate === null) {
      sock.send(handoffAnswer(item, worktreeId, false, note));
    } else {
      if (only && picked.fate !== effectiveFate(item, only))
        sock.send(pieceFate(item, worktreeId, only.id, picked.fate));
      sock.send(handoffAnswer(item, worktreeId, true, note));
      setPressed(row);
    }
    dispatch({ a: "answered", id: worktreeId });
  };
  /** the field opens under a row, which becomes the pick without answering, since the words are
   * still to be written; a field already open elsewhere moves with them. The caret goes in once
   * it is painted, the commit after this one, at the end of what is there. */
  const openNote = (row: number, text: string) => {
    if (starting || !shape[row]) return;
    write([{ selected: [String(row)], note: text }]);
    setCursor(row);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };
  const park = () => dispatch({ a: "card-park", id: worktreeId, cardId: item.id });
  const leaveField = () => {
    const next = dropBlankNote(draft, 0);
    if (next !== draft) write(next);
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
      openNote(cursor, note ?? "");
      return;
    }
    const start = typingStart(e);
    if (start === null) return;
    e.preventDefault();
    // `r` reads the list while nothing is being written
    if (start === "r" && plan && !only && !noting) return read();
    // a field already open takes the letter at its end; a fresh one opens under not now
    openNote(noting ? noted : (notNowRow(shape) ?? cursor), (note ?? "") + start);
  };

  const rows: Choice[] = shape.map((r, i) => ({
    label: r.label,
    ...(pressed === i ? { description: "starting" } : r.description ? { description: r.description } : {}),
    hint: { k: "n", label: "add context", icon: "edit", on: !noting },
    tone: r.fate === null ? "deny" : undefined,
    checked: noting && i === noted,
    field:
      noting && i === noted
        ? {
            ref: field,
            value: note ?? "",
            placeholder: notePlaceholder(r, !!only),
            enterKeyHint: "send",
            onChange: (value) => write([{ selected: [String(noted)], note: value }]),
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
                ? `Starts a worktree in ${only.project.name}, in ${mode} mode${mode === "auto" ? ", which runs without asking" : ""}, with this as its plan. `
                : ""}
              Nothing has started yet.
            </>
          }
        >
          {handoffQuestion(item)}
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
          onHint={(i) => openNote(i, note ?? "")}
        />
      </Card>
    );
  }
  // a list reads like the plan card's byline: the question carries the count, and the list itself
  // is on its page, where each row is read and moved; the card does not repeat it. The mode is
  // said when the go makes a worktree, since it is the mode that worktree's agent starts in
  const counts = handoffCounts(item);
  const makes = counts.worktrees + counts.queued > 0;
  const open = plan ? (
    <Button variant="inline" data-tip="Open it beside the box; any row can still be moved (r)" onClick={() => read()}>
      The list is on its page
    </Button>
  ) : (
    "The list is the agent's"
  );
  return (
    <Card root={root} id={item.id} onKeyDown={onKeyDown}>
      <CardHead
        sub={
          <>
            {open}.{" "}
            {makes
              ? `New worktrees start in ${mode} mode${mode === "auto" ? ", which runs without asking" : ""}. `
              : ""}
            Nothing has started yet.
          </>
        }
      >
        {handoffQuestion(item)}
      </CardHead>
      <Choices
        rows={rows}
        cursor={cursor}
        onCursor={(i) => {
          setCursor(i);
          takeKeyboard(root);
        }}
        onPick={answer}
        onHint={(i) => openNote(i, note ?? "")}
      />
    </Card>
  );
}
