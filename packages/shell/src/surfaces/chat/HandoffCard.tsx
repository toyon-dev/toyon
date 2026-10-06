// The handoff card: a proposal to continue this work in another open project, in the composer box
// the way an ask is, because the box is where the person is looking and nothing has started until
// they say so. It is laid out as the permission card is, since it asks the same shape of question:
// the proposal at the head, the message in the shared block, and the two choices as numbered rows
// reached by digit, arrow or click. Go makes the worktree there; not now closes the card. A note
// is the ask's note: `n` on the go row opens the field under it and makes go the pick, since the
// note is written for the agent go starts, and Enter in the field is then the go.
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
 * second, in the permission card's red */
const GO = 0;
const NOT_NOW = 1;
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
  const onBlur = useAskFocus(root, item.id);
  const sock = useSock();
  const dispatch = useDispatch();
  const touch = useTouch();
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
  const detail = useRef<HTMLDivElement>(null);
  const codeCopy = useCodeCopy(detail);

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
      // the field sits on the go row, which `n` made the pick: Enter in it is the go with the
      // note, as Enter in the ask's field sends its pick. Shift+Enter breaks a line, since a note
      // can be a few. Escape and Tab go back to the rows, and a field left blank goes with them.
      if (isEnter(e) && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        return answer(true);
      }
      if (e.key === "Escape" || (e.key === "Tab" && !e.shiftKey)) {
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
    if (e.key === "n") {
      e.preventDefault();
      return openNote();
    }
  };

  const goBody = (
    <>
      <Kbd k="1" className="ask-num row-dim" />
      <span className="ask-label">go</span>
      {/* the one key that acts on a row rather than the card, said on the row it would act on:
          at the end of the label's line, shown on the cursor's row alone while no note is open,
          and the room kept either way so the label wraps the same */}
      {!touch && (
        <span className={cx("ask-hint row-dim", cursor === GO && !noting && "on")}>
          <Kbd k="n" /> add context
        </span>
      )}
      {starting && <span className="ask-desc row-dim">starting</span>}
    </>
  );

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
        {noting ? (
          // go with a note open on it holds the note's field and is the pick, marked the one way
          // this app marks a selection; it is no longer a button, since it holds the field
          <div
            className="picker-item ask-opt row-edge"
            data-state={rowState({ cursor: !touch && cursor === GO, checked: true })}
            onMouseMove={() => cursor !== GO && setCursor(GO)}
            onMouseDown={toField}
          >
            {goBody}
            <TextArea
              ref={field}
              bare
              font="ui"
              rows={1}
              className="ask-own-field"
              enterKeyHint="send"
              placeholder="a note for the agent there, sent with go"
              value={note}
              onChange={(e) => write(setNote(draft, 0, e.target.value))}
            />
          </div>
        ) : (
          <button
            type="button"
            className="picker-item ask-opt row-edge"
            data-state={rowState({ cursor: !touch && cursor === GO })}
            disabled={starting}
            // mousemove, not mouseenter: a row arriving under a stationary pointer must not steal
            // the highlight the keyboard is on
            onMouseMove={() => cursor !== GO && setCursor(GO)}
            onClick={() => pick(GO)}
          >
            {goBody}
          </button>
        )}
        <button
          type="button"
          className="picker-item ask-opt row-edge deny"
          data-state={rowState({ cursor: !touch && cursor === NOT_NOW })}
          disabled={starting}
          onMouseMove={() => cursor !== NOT_NOW && setCursor(NOT_NOW)}
          onClick={() => pick(NOT_NOW)}
        >
          <Kbd k="2" className="ask-num row-dim" />
          <span className="ask-label">not now</span>
        </button>
      </div>
    </div>
  );
}
