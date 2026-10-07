// The agent asked a question and its turn is stopped until it is answered, so the question takes
// the message box as a card (Card): one of up to four on screen at a time, a tab strip of their
// headers across the top, and one send for the lot.
//
// A question the turn was stopped under comes back into the same box (`onAnswer`): nothing waits
// on it, so its answer is the composer's to send as a message, and there is nothing to skip.

import type { AskAnswer, AskQuestion } from "@toyon/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSock } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { type Choice, type ChoiceField, Choices } from "../../ui/Choices.tsx";
import { handleChoiceKey } from "../../ui/choiceKeys.ts";
import { cx } from "../../ui/cx.ts";
import { Kbd } from "../../ui/Kbd.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import {
  type AskItem,
  advance,
  answered,
  answerParts,
  canSubmit,
  choose,
  cursorFor,
  dropBlankNote,
  emptyDraft,
  isOwnRow,
  openNote,
  ownChosen,
  pageCount,
  recommended,
  rowsOf,
  sendPage,
  setNote,
  stripRecommended,
  walk,
} from "./ask.ts";
import { Card, CardBand, CardFoot, CardHead, type Root } from "./Card.tsx";

export function QuestionCard({
  item,
  ask,
  worktreeId,
  rootRef: root,
  onAnswer,
}: {
  item: AskItem;
  ask: Extract<AskItem["ask"], { kind: "question" }>;
  worktreeId: string;
  rootRef: Root;
  onAnswer?: (answers: AskAnswer[]) => void;
}) {
  const sock = useSock();
  const dispatch = useDispatch();
  const { message, questions } = ask;
  // the answers so far and the question on screen live in the store, so switching worktrees and
  // parking keep them; the cursor is this mount's own and lands on the question's pick
  const stored = useLocalField(worktreeId, "card");
  const held = useMemo(
    () => (stored?.id === item.id ? stored : { id: item.id, draft: emptyDraft(questions), current: 0 }),
    [stored, item.id, questions],
  );
  const { draft, current } = held;
  // the page after the questions, where they read back before they go; no question is open there
  const review = current === sendPage(questions);
  const q = questions[current];
  const answer = draft[current];
  const multi = !!q?.multi;
  const [cursor, setCursor] = useState(() => cursorFor(q, answer));
  const own = useRef<HTMLTextAreaElement>(null);
  // the caret goes into the field before the on-screen keyboard is up; the keyboard then takes
  // half the window, the pages shrink to what is left, and the field is below their new foot
  useEffect(() => {
    const view = window.visualViewport;
    if (!view) return;
    const show = () => {
      if (own.current && own.current === document.activeElement) own.current.scrollIntoView({ block: "nearest" });
    };
    view.addEventListener("resize", show);
    return () => view.removeEventListener("resize", show);
  }, []);
  const write = (next: AskAnswer[], at: number) =>
    dispatch({ a: "card-draft", id: worktreeId, card: { id: item.id, draft: next, current: at } });

  const send = (answers?: AskAnswer[]) => {
    if (onAnswer) {
      if (answers) onAnswer(answers);
      return;
    }
    sock?.send({ t: "agent-answer", worktreeId, askId: item.id, ...(answers ? { answers } : {}) });
    // the answer is the reader's message to the agent, and the turn going on is what they wait for
    // now: the log goes to its end from wherever they had scrolled to read, as it does on a send
    dispatch({ a: "answered", id: worktreeId });
  };
  /** escape gives the plain box back and leaves the question a line at its top */
  const park = () =>
    dispatch(onAnswer ? { a: "ask-revive", id: worktreeId } : { a: "card-park", id: worktreeId, cardId: item.id });
  const submit = () => {
    if (canSubmit(questions, draft)) send(draft);
  };
  /** a question by index: the cursor on its pick, or its first option */
  const go = (at: number) => {
    setCursor(cursorFor(questions[at], draft[at]));
    write(draft, at);
  };
  /** the typed answer's field, opened as the "other" row or as a note on the pick; the caret goes
   * in once the field is painted, which is the commit after this one */
  const type = (asOwn: boolean) => {
    if (!q?.note) return;
    write(openNote(draft, current, asOwn, multi), current);
    requestAnimationFrame(() => own.current?.focus());
  };
  /** `n`: a note on the row the cursor is on. The row becomes the pick without moving on, since
   * the note is still to be written; with nothing picked the field read as the "other" row's
   * answer, which is not what the key says. On the "other" row the field is the answer itself. */
  const note = () => {
    if (!q?.note) return;
    const option = q.options[cursor];
    if (!option || multi) return type(!option);
    write(openNote(choose(draft, current, option.value, false), current, false, false), current);
    requestAnimationFrame(() => own.current?.focus());
  };
  const pick = (oi: number) => {
    if (isOwnRow(q, oi)) {
      setCursor(oi);
      return type(true);
    }
    const option = q?.options[oi];
    if (!q || !option) return;
    const next = choose(draft, current, option.value, multi);
    if (multi) {
      setCursor(oi);
      write(next, current);
      return;
    }
    const to = advance(questions, next, current);
    setCursor(to.cursor);
    write(next, to.current);
    if (to.send && canSubmit(questions, next)) send(next);
  };
  /** back to the rows from the typed answer's field, a field left blank going with it */
  const leaveField = () => {
    const next = dropBlankNote(draft, current);
    if (next !== draft) {
      write(next, current);
      setCursor(cursorFor(q, next[current]));
    }
    root.current?.focus();
  };
  /** enter in the field is the answer, the way it is on a row: on to what is still open, or the
   * send when nothing is, since what is typed here is one line nearly every time. On an on-screen
   * keyboard return answers too, unlike the composer's, where it breaks the line: a message is
   * prose and a note on a pick is not, and the key itself says what it does (`enterKeyHint`). */
  const fieldEnter = () => {
    const next = dropBlankNote(draft, current);
    root.current?.focus();
    if (!answered(next[current])) {
      if (next !== draft) {
        write(next, current);
        setCursor(cursorFor(q, next[current]));
      }
      return;
    }
    const to = advance(questions, next, current);
    setCursor(to.cursor);
    write(next, to.current);
    if (to.send && canSubmit(questions, next)) send(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (
      handleChoiceKey(e, {
        // the send page's rows are the questions, numbered the way the options are: the digit
        // opens that question the way it picks an option, and with no cursor there enter is the
        // send, the keystroke the page was walked to for
        count: review ? questions.length : rowsOf(q),
        cursor: review ? undefined : cursor,
        spacePicks: multi,
        onCursor: setCursor,
        onPick: (at) => (review ? go(at) : pick(at)),
        onSubmit: submit,
        onEscape: park,
        onFieldEnter: fieldEnter,
        onFieldLeave: leaveField,
      })
    )
      return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Tab") {
      e.preventDefault();
      const back = e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey);
      return go(walk(current, back ? -1 : 1, pageCount(questions)));
    }
    if (e.key === "n" && q?.note) {
      e.preventDefault();
      return note();
    }
    if (e.key === "s" && !onAnswer) {
      e.preventDefault();
      return send();
    }
  };

  /** on a lone single-select question the pick is the send (advance): there is no page after it
   * to walk to, so enter on a row answers the ask outright */
  const pickSends = (qq: AskQuestion) => questions.length === 1 && !qq.multi;

  /** the actions under a page: the send where a pick alone is not one (several questions, or a
   * multi-select), the note on the pick where the agent takes one and a pick is made, and the
   * skip. A field open on a lone question has no send: enter in it is the send, as enter on a
   * row is, on every keyboard, and a button arriving under the list moved the box. Nothing lists
   * the keys: the arrows, enter and escape are what they are everywhere, and the one key that is
   * not says so on its row. Each page carries its own foot; it sits at the page's floor so the
   * send is in one place whichever page is open. The agent's stop is not here: it keeps the
   * box's corner, as it does over the plain field. */
  const foot = (qq?: AskQuestion, a?: AskAnswer) => (
    <CardFoot>
      {(!qq || !pickSends(qq)) && (
        <Button variant="outline" size="md" disabled={!canSubmit(questions, draft)} onClick={submit}>
          send
        </Button>
      )}
      {qq?.note && a && a.selected.length > 0 && a.note === undefined && (
        <Button tone="quiet" size="md" onClick={() => type(false)}>
          <Kbd k="n" chip />
          add a note
        </Button>
      )}
      {!onAnswer && (
        <Button tone="quiet" size="md" onClick={() => send()}>
          <Kbd k="s" chip />
          skip
        </Button>
      )}
    </CardFoot>
  );

  /** one question's page: its text, its options, the "other" row, the typed answer's field once
   * opened, and its own foot. Every page is in the DOM so the box stands at the tallest one's
   * height; only the open page has the cursor, the preview and the field's ref. */
  const page = (qq: AskQuestion, i: number) => {
    const open = i === current;
    const a = draft[i];
    const owning = ownChosen(a, !!qq.multi);
    const under = open ? qq.options[cursor] : undefined;
    /* the field a row holds once something is typed against it. The on-screen keyboard's return
       key is named for what enter does from here: on a lone question the answer is the send, with
       several it walks on (to a question still open, or the send page). Decided by the shape of
       the ask and not by the draft, so the label does not flip under the thumb as the first
       character lands. */
    const field = (placeholder: string): ChoiceField => ({
      ref: open ? own : undefined,
      value: a?.note ?? "",
      placeholder,
      enterKeyHint: sendPage(questions) === -1 ? "send" : "next",
      onChange: (value) => write(setNote(draft, i, value), i),
    });
    const rows: Choice[] = qq.options.map((o) => {
      const on = !!a?.selected.includes(o.value);
      return {
        // the agent's own convention for the option it would pick, read off the label and worn
        // as a badge, so the label itself is the choice and nothing more
        label: (
          <>
            {stripRecommended(o.label)}
            {recommended(o.label) && <span className="badge-recommended">recommended</span>}
          </>
        ),
        description: o.description,
        // a multi-select's `n` is the typed answer, not a note
        hint: qq.note && !qq.multi ? { k: "n", label: "add a note", on: a?.note === undefined } : undefined,
        checked: on,
        // the pick with a note open on it holds the note's field
        field: on && !owning && a?.note !== undefined ? field("a note for the agent, sent with your pick") : undefined,
      };
    });
    // the typed answer as one more row, numbered after the options so it lines up with them and
    // is reached the same way; it opens the field rather than moving on. Once the answer is its
    // own, the field is the row's description: it takes that line, its placeholder the same
    // words, so opening it moves nothing.
    if (qq.note)
      rows.push({
        label: qq.note.label,
        description: owning ? undefined : "your own answer",
        checked: owning,
        field: owning ? field("your own answer") : undefined,
      });
    return (
      <div key={qq.id} className={cx("card-page", !open && "card-page-off")}>
        <CardHead>{qq.text || message}</CardHead>
        <Choices
          rows={rows}
          cursor={open ? cursor : undefined}
          onCursor={setCursor}
          onPick={(oi) => {
            pick(oi);
            // the row took focus on the press; the keys belong to the root
            root.current?.focus();
          }}
        />
        {under?.preview && <CardBand code={under.preview} still />}
        {foot(qq, a)}
      </div>
    );
  };

  return (
    <Card root={root} id={item.id} onKeyDown={onKeyDown}>
      {/* the questions as tabs across the top: the headers are the agent's short names for them,
          and the one open joins the page under it. A dot on each says which are answered. The
          send stands apart at the far end: it is the step after the questions, not one of them. */}
      {questions.length > 1 && (
        <div className="card-tabs">
          <Tabs
            label="questions"
            owner="ask"
            items={[
              ...questions.map((qq, i) => ({
                id: String(i),
                label: qq.header || `question ${i + 1}`,
                lead: <span className={cx("dot card-step", answered(draft[i]) && "answered")} />,
              })),
              { id: String(questions.length), label: "send", far: true },
            ]}
            current={String(current)}
            onPick={(id) => {
              go(Number(id));
              // the tab took focus on the press; the keys belong to the root
              root.current?.focus();
            }}
          />
        </div>
      )}
      <div className="card-pages">
        {questions.map(page)}
        {/* the send page: each question's pick read back after its header, a note under it on the
            description line as it was typed, and a press on the row opens that question. Nothing
            is checked here, since the row is a way back, not a pick. */}
        {sendPage(questions) !== -1 && (
          <div className={cx("card-page", !review && "card-page-off")}>
            <CardHead>Send these answers?</CardHead>
            <Choices
              hover
              rows={questions.map((qq, i) => {
                const parts = answered(draft[i]) ? answerParts(qq, draft[i]) : undefined;
                return {
                  label: (
                    <>
                      <span className="row-dim">{qq.header || `question ${i + 1}`}</span>{" "}
                      <span className={cx(!parts && "row-dim")}>{parts ? parts.pick : "no answer yet"}</span>
                    </>
                  ),
                  description: parts?.note,
                };
              })}
              onPick={(i) => {
                go(i);
                root.current?.focus();
              }}
            />
            {foot()}
          </div>
        )}
      </div>
    </Card>
  );
}
