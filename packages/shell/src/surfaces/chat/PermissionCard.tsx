// The agent asks leave to do something and its turn is stopped until it is decided, so the
// permission takes the message box as a card (Card): the agent's sentence at the head, the command
// or the plan it is about in the band, and the agent's own options as the choices, one press each.
//
// A row also takes words, the handoff card's way: `n` opens a field under the cursor's row, which
// becomes the pick, and enter in the field is that pick. A letter typed on the card opens the
// field under the no with the letter in it, since words on a plan card are nearly always what to
// change, and knowing a key should not be the price of saying so. The pick is the answer; the
// words follow it to the agent as a message of the person's own, because the agent's request
// takes an option id and nothing else. The field is the box's ask draft, so switching worktrees
// and parking keep it.

import type { AskAnswer } from "@toyon/shared";
import { useMemo, useRef, useState } from "react";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { type Choice, Choices } from "../../ui/Choices.tsx";
import { handleChoiceKey } from "../../ui/choiceKeys.ts";
import { useOnChange } from "../../ui/hooks.ts";
import type { AskItem } from "./ask.ts";
import { Card, CardBand, CardHead, type Root } from "./Card.tsx";
import { renderMarkdown } from "./markdown.ts";
import { rejectRow, typingStart } from "./permissionNote.ts";
import { unwrapShell } from "./toolCall.ts";

/** one slot: the row the words are under is its pick, and the words are its note */
const BLANK: AskAnswer[] = [{ selected: [] }];

export function PermissionCard({
  item,
  ask,
  worktreeId,
  rootRef: root,
}: {
  item: AskItem;
  ask: Extract<AskItem["ask"], { kind: "permission" }>;
  worktreeId: string;
  rootRef: Root;
}) {
  const sock = useSock();
  const dispatch = useDispatch();
  const active = useStore((s) => s.activeId);
  const stored = useLocalField(worktreeId, "card");
  const draft = stored?.id === item.id ? stored.draft : BLANK;
  // undefined is the field shut; "" is the field open with nothing typed yet
  const note = draft[0]?.note;
  const noting = note !== undefined;
  // the row the field is under, named by the pick in the draft
  const noted = noting ? ask.choices.findIndex((c) => c.id === draft[0]?.selected[0]) : -1;
  const field = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  const plan = ask.plan;
  // a plan is a file in the worktree, the agent's own or one toyon wrote for it, read in the pane
  // as the document it is; only an ask with no file behind it still carries its markdown
  const html = useMemo(() => (ask.detail && !plan ? renderMarkdown(ask.detail) : ""), [ask.detail, plan]);
  const readPlan = () => {
    // the caret stays on the ask, which is what the agent is blocked on
    if (plan && active === worktreeId)
      openFile({ sock, dispatch }, { worktreeId, path: plan, view: "preview", focus: false });
  };
  // the plan opens beside the box as the ask arrives: it is what the options are asking about
  useOnChange([item.id, plan], readPlan);

  const write = (next: AskAnswer[]) =>
    dispatch({ a: "card-draft", id: worktreeId, card: { id: item.id, draft: next, current: 0 } });
  /** the field opens under a row, which becomes the pick without moving on, since the words are
   * still to be written; a field already open elsewhere moves with them. The caret goes in once
   * it is painted, the commit after this one, at the end of what is there. */
  const openNote = (row: number, text: string) => {
    const choice = ask.choices[row];
    if (!choice) return;
    write([{ selected: [choice.id], note: text }]);
    setCursor(row);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };
  const decide = (i: number) => {
    const choice = ask.choices[i];
    if (!choice) return;
    // the words go with whatever was picked: typed under one row and answered by another's
    // digit, they are still what the person had to say
    const words = note?.trim();
    sock?.send({
      t: "agent-decide",
      worktreeId,
      askId: item.id,
      choiceId: choice.id,
      ...(words ? { note: words } : {}),
    });
    // the decision is the reader's word to the agent: the log goes to its end as it does on a send
    dispatch({ a: "answered", id: worktreeId });
  };
  /** escape gives the plain box back and leaves the card a line at its top */
  const park = () => dispatch({ a: "card-park", id: worktreeId, cardId: item.id });
  /** back to the rows from the field, a field left blank going with it */
  const leaveField = () => {
    if (!note?.trim()) write(BLANK);
    root.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (
      handleChoiceKey(e, {
        count: ask.choices.length,
        cursor,
        onCursor: setCursor,
        onPick: decide,
        onEscape: park,
        // the field sits on the row `n` made the pick: enter in it is that pick with the words
        onFieldEnter: () => decide(noted),
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
    // a field already open takes the letter at its end; a fresh one opens under the no
    openNote(noting ? noted : (rejectRow(ask.choices) ?? cursor), (note ?? "") + start);
  };

  const rows: Choice[] = ask.choices.map((c, i) => {
    const deny = c.kind.startsWith("reject");
    const holds = noting && i === noted;
    return {
      label: c.name,
      tone: deny ? "deny" : undefined,
      hint: { k: "n", label: "add context", icon: "edit", on: !noting },
      checked: holds,
      field: holds
        ? {
            ref: field,
            value: note,
            placeholder: deny ? "what to change, sent with your no" : "a note for the work, sent with your yes",
            enterKeyHint: "send",
            onChange: (value) => write([{ selected: [c.id], note: value }]),
          }
        : undefined,
    };
  });

  return (
    <Card root={root} id={item.id} onKeyDown={onKeyDown}>
      <CardHead>{ask.title}</CardHead>
      {/* the command a yes would run, under the sentence that asked for it, read the way the
          call's row reads it: without the shell an adapter wrapped it in */}
      {ask.command && <CardBand code={unwrapShell(ask.command)} />}
      {html && <CardBand html={html} />}
      <Choices
        rows={rows}
        cursor={cursor}
        onCursor={setCursor}
        onPick={decide}
        onHint={(i) => openNote(i, note ?? "")}
      />
    </Card>
  );
}
