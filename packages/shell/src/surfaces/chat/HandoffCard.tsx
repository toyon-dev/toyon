// The handoff card: a proposal to continue this work in another open project, in the composer box
// the way an ask is, because the box is where the person is looking and nothing has started until
// they say so. Go makes the worktree there; a note typed here rides with the message; Not now
// closes it. The message is shown whole, since the person is the one gate on what another
// project's agent will start from.
//
// On the ask's pieces: the root takes the keyboard and reads its keys, every key has a button
// behind it, Escape parks the card and gives the plain box back, and the note is the box's ask
// draft so switching worktrees and parking keep it.

import type { AskAnswer } from "@toyon/shared";
import { useMemo, useRef, useState } from "react";
import { useDispatch, useSock } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { TextArea } from "../../ui/Field.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { isEnter, type Root, useAskFocus } from "./AskBox.tsx";
import { dropBlankNote, setNote, shellChord } from "./ask.ts";
import { type HandoffItem, handoffAnswer, lineCount, needsFold } from "./handoff.ts";
import { renderMarkdown } from "./markdown.ts";
import { useCodeCopy } from "./useCodeCopy.tsx";

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
  const onBlur = useAskFocus(root, item.id);
  const sock = useSock();
  const dispatch = useDispatch();
  const stored = useLocalField(worktreeId, "ask");
  const draft = stored?.id === item.id ? stored.draft : BLANK;
  // undefined is the field shut; "" is the field open with nothing typed yet
  const note = draft[0]?.note;
  const write = (next: AskAnswer[]) =>
    dispatch({ a: "ask-draft", id: worktreeId, ask: { id: item.id, draft: next, current: 0 } });
  const field = useRef<HTMLTextAreaElement>(null);
  // Go went out and the daemon is making the worktree: the handoff event closes the card, or a
  // decline with the reason does, so this only holds the buttons until one of them lands
  const [starting, setStarting] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const html = useMemo(() => renderMarkdown(item.message), [item.message]);
  const detail = useRef<HTMLDivElement>(null);
  const codeCopy = useCodeCopy(detail);
  const foldable = needsFold(item.message);
  const folded = foldable && !unfolded;

  const answer = (go: boolean) => {
    if (starting || !sock) return;
    sock.send(handoffAnswer(item, worktreeId, go, note));
    if (go) setStarting(true);
  };
  /** escape gives the plain box back and leaves the card a line at its top */
  const park = () => dispatch({ a: "ask-park", id: worktreeId, askId: item.id });
  /** the note's field, opened on demand; the caret goes in once it is painted, the commit after this one */
  const openNote = () => {
    if (note === undefined) write(setNote(draft, 0, ""));
    requestAnimationFrame(() => field.current?.focus());
  };
  /** back to the root from the field, a field left blank going with it */
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
      // the note's field never sends: Go is a step past writing context for it, so Enter here
      // goes back to the root, where the next Enter is the Go. Shift+Enter breaks a line, since a
      // note can be a few. Escape and Tab go back too, and a field left blank goes with them.
      if (e.key === "Escape" || (e.key === "Tab" && !e.shiftKey) || (isEnter(e) && !e.shiftKey)) {
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
      return answer(true);
    }
    if (e.key === "n") {
      e.preventDefault();
      return openNote();
    }
    if (e.key === "s") {
      e.preventDefault();
      return answer(false);
    }
  };

  return (
    <div ref={root} className="ask-box" tabIndex={-1} onKeyDown={onKeyDown} onBlur={onBlur}>
      <div className="ask-head">
        <div className="ask-text">Continue in {item.repo.name}?</div>
      </div>
      {/* where it goes and in what mode, since two open projects can share a name and the mode is
          what the new agent may do without asking: auto is said in those words, because this
          message, written by an agent, becomes that agent's first prompt with no card in between;
          and whose idea it was, since a message written by an agent is read differently from one
          the person asked for */}
      <div className="ask-desc">
        Starts a worktree in {item.repo.path}, in {item.mode} mode
        {item.mode === "auto" ? ", which runs without asking" : ""}. Nothing has started yet.{" "}
        {item.by === "agent" ? "Proposed by this worktree's agent." : "You asked for this."}
      </div>
      {/* the markup goes into a child of the detail so the detail keeps a child of its own beside it */}
      <div ref={detail} className={cx("handoff-detail md", folded && "folded")}>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {codeCopy}
      </div>
      {foldable && (
        <Button variant="inline" tone="quiet" className="handoff-fold" onClick={() => setUnfolded(!unfolded)}>
          {folded ? `show all ${lineCount(item.message)} lines` : "show less"}
        </Button>
      )}
      {/* the note, in the row the ask's own field takes: one line that grows with what is typed */}
      {note !== undefined && (
        <div className="ask-options">
          <div className="picker-item ask-opt" onMouseDown={toField}>
            <TextArea
              ref={field}
              bare
              font="ui"
              rows={1}
              className="ask-own-field"
              enterKeyHint="done"
              placeholder={`context for the agent in ${item.repo.name}, sent with the message`}
              value={note}
              onChange={(e) => write(setNote(draft, 0, e.target.value))}
            />
          </div>
        </div>
      )}
      <div className="ask-foot">
        <Button tone="primary" size="md" busy={starting} onClick={() => answer(true)}>
          go
        </Button>
        {note === undefined && (
          <Button tone="quiet" size="md" disabled={starting} onClick={openNote}>
            <Kbd k="n" chip />
            add context
          </Button>
        )}
        <Button tone="quiet" size="md" disabled={starting} onClick={() => answer(false)}>
          <Kbd k="s" chip />
          not now
        </Button>
        {starting && <span className="ask-desc">starting</span>}
      </div>
    </div>
  );
}
