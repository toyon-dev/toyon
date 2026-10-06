// The handoff card: a proposal to continue this work in another open project, in the composer box
// the way an ask is, because the box is where the person is looking and nothing has started until
// they say so. It is laid out as the permission card is, since it asks the same shape of question:
// the proposal at the head, the message in the shared block, and the choices as numbered rows
// reached by digit, arrow or click. Go makes the worktree there; not now closes the card; the
// third row is the note that rides with go, opened in place the way the ask's own answer is.
//
// On the ask's pieces: the root takes the keyboard and reads its keys, every key has a row behind
// it, Escape parks the card and gives the plain box back, and the note is the box's ask draft so
// switching worktrees and parking keep it.

import type { AskAnswer } from "@toyon/shared";
import { useMemo, useRef, useState } from "react";
import { useDispatch, useSock } from "../../state/context.tsx";
import { useLocalField, useTouch } from "../../state/selectors.ts";
import { cx } from "../../ui/cx.ts";
import { TextArea } from "../../ui/Field.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { step } from "../../ui/listNav.ts";
import { rowState } from "../../ui/rowState.ts";
import { isDigit, isEnter, type Root, useAskFocus } from "./AskBox.tsx";
import { dropBlankNote, setNote, shellChord } from "./ask.ts";
import { type HandoffItem, handoffAnswer } from "./handoff.ts";
import { renderMarkdown } from "./markdown.ts";
import { useCodeCopy } from "./useCodeCopy.tsx";

/** one slot, no pick: the note is the whole of what the card takes from the person */
const BLANK: AskAnswer[] = [{ selected: [] }];

/** the rows, in digit order: go first, so Enter on an untouched card is the go; the refusal
 * second, in the permission card's red; the note last, as the ask's own answer is */
const GO = 0;
const NOT_NOW = 1;
const NOTE = 2;
const ROWS = 3;

export function HandoffCard({
  item,
  worktreeId,
  rootRef: root,
}: {
  item: HandoffItem;
  worktreeId: string;
  rootRef: Root;
}) {
  const onBlur = useAskFocus(root, item.id);
  const sock = useSock();
  const dispatch = useDispatch();
  const touch = useTouch();
  const stored = useLocalField(worktreeId, "ask");
  const draft = stored?.id === item.id ? stored.draft : BLANK;
  // undefined is the field shut; "" is the field open with nothing typed yet
  const note = draft[0]?.note;
  const write = (next: AskAnswer[]) =>
    dispatch({ a: "ask-draft", id: worktreeId, ask: { id: item.id, draft: next, current: 0 } });
  const field = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(GO);
  // Go went out and the daemon is making the worktree: the handoff event closes the card, or a
  // decline with the reason does, so this only holds the rows until one of them lands
  const [starting, setStarting] = useState(false);
  const html = useMemo(() => renderMarkdown(item.message), [item.message]);
  const detail = useRef<HTMLDivElement>(null);
  const codeCopy = useCodeCopy(detail);

  const answer = (go: boolean) => {
    if (starting || !sock) return;
    sock.send(handoffAnswer(item, worktreeId, go, note));
    if (go) setStarting(true);
    // the decision is the reader's word, so the log goes to its end as it does on a send
    dispatch({ a: "answered", id: worktreeId });
  };
  /** the note's field, opened in its row; the caret goes in once it is painted, the commit after this one */
  const openNote = () => {
    if (note === undefined) write(setNote(draft, 0, ""));
    setCursor(NOTE);
    requestAnimationFrame(() => field.current?.focus());
  };
  /** what a row does when picked, by digit, Enter or click */
  const pick = (i: number) => {
    if (i === GO) return answer(true);
    if (i === NOT_NOW) return answer(false);
    if (i === NOTE) return openNote();
  };
  /** escape gives the plain box back and leaves the card a line at its top */
  const park = () => dispatch({ a: "ask-park", id: worktreeId, askId: item.id });
  /** back to the rows from the field, a field left blank going with it */
  const toRoot = () => {
    const next = dropBlankNote(draft, 0);
    if (next !== draft) write(next);
    root.current?.focus();
  };
  /** a press on the field's row beside the field: the caret goes in rather than being dropped */
  const toField = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    field.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLTextAreaElement) {
      // Enter in the field never decides: on the ask, Enter in the field sends because a pick was
      // made first, and here nothing has been picked yet, so a person finishing a note with Enter
      // and meaning not now would have said go. Enter, Escape and Tab go back to the rows with
      // the note kept, where the next Enter is the cursor's row; Shift+Enter breaks a line, since
      // a note can be a few. A field left blank goes with the way back.
      if ((isEnter(e) && !e.shiftKey) || e.key === "Escape" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        toRoot();
      }
      return;
    }
    if (shellChord(e)) return;
    if (e.key === "Escape") {
      // the app-wide esc would close a pane or stop the turn
      e.preventDefault();
      e.stopPropagation();
      return park();
    }
    if (isEnter(e)) {
      // a button the mouse just focused would press itself on enter too
      e.preventDefault();
      return pick(cursor);
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      return setCursor(step(cursor, e.key === "ArrowUp" ? -1 : 1, ROWS));
    }
    if (isDigit(e.key) && Number(e.key) <= ROWS) {
      e.preventDefault();
      return pick(Number(e.key) - 1);
    }
  };

  const state = (i: number) => rowState({ cursor: !touch && i === cursor });

  return (
    <div ref={root} className="ask-box" tabIndex={-1} onKeyDown={onKeyDown} onBlur={onBlur}>
      <div className="ask-head">
        <div className="ask-text">Continue in {item.repo.name}?</div>
        {/* where it goes and in what mode, since two open projects can share a name and the mode
            is what the new agent may do without asking: auto is said in those words, because this
            message, written by an agent, becomes that agent's first prompt with no card in
            between; and whose idea it was, since a message written by an agent is read
            differently from one the person asked for */}
        <div className="ask-desc">
          Starts a worktree in {item.repo.path}, in {item.mode} mode
          {item.mode === "auto" ? ", which runs without asking" : ""}. Nothing has started yet.{" "}
          {item.by === "agent" ? "Proposed by this worktree's agent." : "You asked for this."}
        </div>
      </div>
      {/* the message whole, in the block a plan is read in: the person is the one gate on what
          another project's agent will start from, so nothing of it is folded away */}
      <div ref={detail} className="ask-block md">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {codeCopy}
      </div>
      <div className="ask-options">
        <button
          type="button"
          className="picker-item ask-opt row-edge"
          data-state={state(GO)}
          disabled={starting}
          // mousemove, not mouseenter: a row arriving under a stationary pointer must not steal
          // the highlight the keyboard is on
          onMouseMove={() => cursor !== GO && setCursor(GO)}
          onClick={() => pick(GO)}
        >
          <Kbd k="1" className="ask-num row-dim" />
          <span className="ask-label">go</span>
          {starting && <span className="ask-desc row-dim">starting</span>}
        </button>
        <button
          type="button"
          className={cx("picker-item ask-opt row-edge", "deny")}
          data-state={state(NOT_NOW)}
          disabled={starting}
          onMouseMove={() => cursor !== NOT_NOW && setCursor(NOT_NOW)}
          onClick={() => pick(NOT_NOW)}
        >
          <Kbd k="2" className="ask-num row-dim" />
          <span className="ask-label">not now</span>
        </button>
        {/* the note as one more row, numbered after the choices so it lines up with them and is
            reached the same way; it opens the field in place rather than deciding anything */}
        {note === undefined ? (
          <button
            type="button"
            className="picker-item ask-opt row-edge"
            data-state={state(NOTE)}
            disabled={starting}
            onMouseMove={() => cursor !== NOTE && setCursor(NOTE)}
            onClick={() => pick(NOTE)}
          >
            <Kbd k="3" className="ask-num row-dim" />
            <span className="ask-label">add context</span>
            <span className="ask-desc row-dim">a note sent with go</span>
          </button>
        ) : (
          // once the note is being written, the field is the row's description: it takes that
          // line, so opening it moves nothing. The row is no longer a button, since it holds the field.
          <div
            className="picker-item ask-opt row-edge"
            data-state={state(NOTE)}
            onMouseMove={() => cursor !== NOTE && setCursor(NOTE)}
            onMouseDown={toField}
          >
            <Kbd k="3" className="ask-num row-dim" />
            <span className="ask-label">add context</span>
            <TextArea
              ref={field}
              bare
              font="ui"
              rows={1}
              className="ask-own-field"
              enterKeyHint="done"
              placeholder="a note sent with go; enter returns to the rows"
              value={note}
              onChange={(e) => write(setNote(draft, 0, e.target.value))}
            />
          </div>
        )}
      </div>
    </div>
  );
}
