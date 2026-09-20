// The agent asked something and its turn is stopped until this is answered, so the question takes
// the message box: the keyboard is already there, the box never scrolls away, and it is where a
// reply is written anyway. Two bodies behind one root: a question (one of up to four on screen at
// a time, a tab strip of their headers across the top, one send for the lot) and a permission
// (the agent's own options, one press each).
//
// The root is the focused element and reads its own keys, and every key has a button behind it:
// the digit and the click run the same handler, so nothing here is keyboard-only. Escape parks the
// ask and gives the plain box back; the ask stays open, since it is still what the agent waits on.

import type { AskAnswer } from "@toyon/shared";
import { type RefObject, useMemo, useRef, useState } from "react";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocalField, useTouch } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { TextArea } from "../../ui/Field.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { Kbd } from "../../ui/Kbd.tsx";
import { KeyHints } from "../../ui/KeyHints.tsx";
import { step } from "../../ui/listNav.ts";
import { rowState } from "../../ui/rowState.ts";
import { Tabs } from "../../ui/Tabs.tsx";
import {
  type AskItem,
  advance,
  answered,
  canSubmit,
  choose,
  cursorFor,
  dropBlankNote,
  emptyDraft,
  isOwnRow,
  openNote,
  ownChosen,
  recommended,
  rowForDigit,
  rowsOf,
  setNote,
  stripRecommended,
  walk,
} from "./ask.ts";
import { renderMarkdown } from "./markdown.ts";

type Root = RefObject<HTMLDivElement>;

/** an element that is keeping the keyboard for good reason: an editor, a terminal, a field
 * elsewhere. The box's own textarea and a row in the transcript or the rail are not. */
function holdsKeyboard(el: Element | null): boolean {
  if (!el || el === document.body) return false;
  if (el.closest(".monaco-editor, .xterm")) return true;
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.closest(".chat-input");
}

/** The root takes the keyboard as it mounts (the ask arriving, or coming back from parked), because
 * nothing else in the worktree is useful while the agent is blocked, unless a hand is somewhere
 * that plainly wants it. And it takes it back when a click dropped it nowhere: a click on the
 * transcript's text, to read or to scroll, lands focus on the body, and from there every digit
 * went dead with nothing on screen saying so. A click that lands somewhere (a row, a field, the
 * preview) keeps what it landed on. */
function useAskFocus(root: Root, id: string) {
  useOnChange([id], () => {
    // rAF because the root is painted in the same commit that mounts it
    const f = requestAnimationFrame(() => {
      if (!holdsKeyboard(document.activeElement)) root.current?.focus();
    });
    return () => cancelAnimationFrame(f);
  });
  return (e: React.FocusEvent) => {
    if (e.relatedTarget) return;
    // the body is only known after the event: a click into the preview reports no target either,
    // and the iframe is what holds focus by the next frame
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) root.current?.focus();
    });
  };
}

export function AskBox({ item, worktreeId, rootRef }: { item: AskItem; worktreeId: string; rootRef: Root }) {
  return item.ask.kind === "question" ? (
    <QuestionBody item={item} ask={item.ask} worktreeId={worktreeId} root={rootRef} />
  ) : (
    <PermissionBody item={item} ask={item.ask} worktreeId={worktreeId} root={rootRef} />
  );
}

const isDigit = (key: string) => key.length === 1 && key >= "1" && key <= "9";
const isEnter = (e: React.KeyboardEvent) => e.key === "Enter" || e.key === "NumpadEnter";

function QuestionBody({
  item,
  ask,
  worktreeId,
  root,
}: {
  item: AskItem;
  ask: Extract<AskItem["ask"], { kind: "question" }>;
  worktreeId: string;
  root: Root;
}) {
  const onBlur = useAskFocus(root, item.id);
  const sock = useSock();
  const dispatch = useDispatch();
  const { message, questions } = ask;
  // the answers so far and the question on screen live in the store, so switching worktrees and
  // parking keep them; the cursor is this mount's own and lands on the question's pick
  const stored = useLocalField(worktreeId, "ask");
  const held = useMemo(
    () => (stored?.id === item.id ? stored : { id: item.id, draft: emptyDraft(questions), current: 0 }),
    [stored, item.id, questions],
  );
  const { draft, current } = held;
  const q = questions[current];
  const answer = draft[current];
  const multi = !!q?.multi;
  const [cursor, setCursor] = useState(() => cursorFor(q, answer));
  // the cursor is where the keyboard is, and a touch window has none: drawn there, it sat on the
  // first row before anything was tapped and read as a choice already made, beside the badge
  const touch = useTouch();
  const own = useRef<HTMLTextAreaElement>(null);
  const write = (next: AskAnswer[], at: number) =>
    dispatch({ a: "ask-draft", id: worktreeId, ask: { id: item.id, draft: next, current: at } });

  const send = (answers?: AskAnswer[]) =>
    sock?.send({ t: "agent-answer", worktreeId, askId: item.id, ...(answers ? { answers } : {}) });
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLTextAreaElement) {
      // the typed answer's field reads its own keys. Enter is the answer, the way it is on a row:
      // on to what is still open, or the send when nothing is, since what is typed here is one
      // line nearly every time; shift+enter is the line break for the other times, and the chord
      // sends from anywhere. Escape and tab go back to the options, and a field left blank goes
      // with them.
      if (e.key === "Escape" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        const next = dropBlankNote(draft, current);
        if (next !== draft) {
          write(next, current);
          setCursor(cursorFor(q, next[current]));
        }
        root.current?.focus();
      } else if (isEnter(e) && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      } else if (isEnter(e) && !e.shiftKey) {
        e.preventDefault();
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
      }
      return;
    }
    if (e.key === "Escape") {
      // the app-wide esc would close a pane or stop the turn
      e.preventDefault();
      e.stopPropagation();
      return dispatch({ a: "ask-park", id: worktreeId, askId: item.id });
    }
    if (isEnter(e) && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      return submit();
    }
    if (isEnter(e) || (e.key === " " && multi)) {
      // a button the mouse just focused would press itself on enter too
      e.preventDefault();
      return pick(cursor);
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      return setCursor(step(cursor, e.key === "ArrowUp" ? -1 : 1, rowsOf(q)));
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Tab") {
      e.preventDefault();
      const back = e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey);
      return go(walk(current, back ? -1 : 1, questions.length));
    }
    if (e.key === "n" && q?.note) {
      e.preventDefault();
      return type(false);
    }
    if (e.key === "s") {
      e.preventDefault();
      return send();
    }
    if (isDigit(e.key)) {
      const row = rowForDigit(q, Number(e.key));
      if (row === -1) return;
      e.preventDefault();
      return pick(row);
    }
  };

  const hints: Array<[string, string]> = [
    ...(questions.length > 1 ? [["←→", "question"] as [string, string]] : []),
    ["↑↓", "move"],
    ["⏎", "choose"],
    ...(q?.note ? [["n", "add a note"] as [string, string]] : []),
    ["⌘⏎", "send"],
    ["esc", "reply instead"],
  ];
  const under = q?.options[cursor];
  const owning = ownChosen(answer, multi);
  const noteOpen = answer?.note !== undefined;

  return (
    <div ref={root} className="ask-box" tabIndex={-1} onKeyDown={onKeyDown} onBlur={onBlur}>
      {/* the questions as tabs across the top: the headers are the agent's short names for them,
          and the one open joins the question under it. A dot on each says which are answered. */}
      {questions.length > 1 && (
        <div className="ask-tabs">
          <Tabs
            label="questions"
            owner="ask"
            items={questions.map((qq, i) => ({
              id: qq.id,
              label: qq.header || `question ${i + 1}`,
              lead: <span className={cx("dot ask-step", answered(draft[i]) && "answered")} />,
            }))}
            current={q?.id ?? ""}
            onPick={(id) => {
              go(questions.findIndex((qq) => qq.id === id));
              // the tab took focus on the press; the keys belong to the root
              root.current?.focus();
            }}
          />
        </div>
      )}
      <div className="ask-head">
        {questions.length === 1 && q?.header && <div className="section-title ask-header">{q.header}</div>}
        <div className="ask-text">{q?.text || message}</div>
      </div>
      <div className="ask-options">
        {q?.options.map((o, oi) => {
          const on = answer?.selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              className="picker-item ask-opt row-edge"
              data-state={rowState({ cursor: !touch && oi === cursor, checked: on })}
              // mousemove, not mouseenter, for the same reason the picker gives: a row arriving
              // under a stationary pointer must not steal the highlight the keyboard is on
              onMouseMove={() => oi !== cursor && setCursor(oi)}
              onClick={() => {
                pick(oi);
                root.current?.focus();
              }}
            >
              <Kbd k={String(oi + 1)} className="ask-num row-dim" />
              <span className="ask-label">
                {stripRecommended(o.label)}
                {recommended(o.label) && <span className="badge-recommended">recommended</span>}
              </span>
              {o.description && <span className="ask-desc row-dim">{o.description}</span>}
            </button>
          );
        })}
        {/* the typed answer as one more row, numbered after the options so it lines up with them
            and is reached the same way; it opens the field rather than moving on */}
        {q?.note && (
          <button
            type="button"
            className="picker-item ask-opt row-edge"
            data-state={rowState({ cursor: !touch && cursor === q.options.length, checked: owning })}
            onMouseMove={() => cursor !== q.options.length && setCursor(q.options.length)}
            onClick={() => pick(q.options.length)}
          >
            <Kbd k={String(q.options.length + 1)} className="ask-num row-dim" />
            <span className="ask-label">{q.note.label}</span>
            <span className="ask-desc row-dim">your own answer</span>
          </button>
        )}
      </div>
      {under?.preview && <pre className="ask-preview">{under.preview}</pre>}
      {q?.note && noteOpen && (
        <TextArea
          ref={own}
          bare
          font="ui"
          rows={2}
          className="ask-own"
          placeholder={owning ? `${q.note.label}: your own answer` : "a note for the agent, sent with your pick"}
          value={answer?.note ?? ""}
          onChange={(e) => write(setNote(draft, current, e.target.value), current)}
        />
      )}
      <div className="ask-foot">
        <Button variant="outline" size="md" disabled={!canSubmit(questions, draft)} onClick={submit}>
          send
        </Button>
        <Button tone="quiet" size="md" onClick={() => send()}>
          <Kbd k="s" chip />
          skip
        </Button>
      </div>
      <KeyHints hints={hints} className="ask-keys" />
    </div>
  );
}

const PERMISSION_KEYS: Array<[string, string]> = [
  ["↑↓", "move"],
  ["⏎", "choose"],
  ["esc", "reply instead"],
];

function PermissionBody({
  item,
  ask,
  worktreeId,
  root,
}: {
  item: AskItem;
  ask: Extract<AskItem["ask"], { kind: "permission" }>;
  worktreeId: string;
  root: Root;
}) {
  const onBlur = useAskFocus(root, item.id);
  const sock = useSock();
  const dispatch = useDispatch();
  const active = useStore((s) => s.activeId);
  const [cursor, setCursor] = useState(0);
  const touch = useTouch();
  const plan = ask.plan;
  // a plan is a file toyon wrote to the worktree, read in the pane as the document it is; only an
  // ask with no file behind it still carries its markdown
  const html = useMemo(() => (ask.detail && !plan ? renderMarkdown(ask.detail) : ""), [ask.detail, plan]);
  const readPlan = () => {
    // the caret stays on the ask, which is what the agent is blocked on
    if (plan && active === worktreeId)
      openFile({ sock, dispatch }, { worktreeId, path: plan, view: "preview", focus: false });
  };
  // the plan opens beside the box as the ask arrives: it is what the options are asking about
  useOnChange([item.id, plan], readPlan);
  const decide = (i: number) => {
    const choice = ask.choices[i];
    if (choice) sock?.send({ t: "agent-decide", worktreeId, askId: item.id, choiceId: choice.id });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return dispatch({ a: "ask-park", id: worktreeId, askId: item.id });
    }
    if (isEnter(e)) {
      e.preventDefault();
      return decide(cursor);
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      return setCursor(step(cursor, e.key === "ArrowUp" ? -1 : 1, ask.choices.length));
    }
    if (isDigit(e.key) && ask.choices[Number(e.key) - 1]) {
      e.preventDefault();
      decide(Number(e.key) - 1);
    }
  };

  return (
    <div ref={root} className="ask-box" tabIndex={-1} onKeyDown={onKeyDown} onBlur={onBlur}>
      <div className="ask-head">
        <div className="ask-text">{ask.title}</div>
      </div>
      {html && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown
        <div className="ask-detail md" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {plan && (
        <div className="ask-plan hint">
          the plan is in{" "}
          <Button variant="inline" mono onClick={readPlan}>
            {plan}
          </Button>
        </div>
      )}
      <div className="ask-options">
        {ask.choices.map((c, i) => (
          <button
            key={c.id}
            type="button"
            className={cx("picker-item ask-opt row-edge", c.kind.startsWith("reject") && "deny")}
            data-state={rowState({ cursor: !touch && i === cursor })}
            onMouseMove={() => i !== cursor && setCursor(i)}
            onClick={() => decide(i)}
          >
            <Kbd k={String(i + 1)} className="ask-num row-dim" />
            <span className="ask-label">{c.name}</span>
          </button>
        ))}
      </div>
      <KeyHints hints={PERMISSION_KEYS} className="ask-keys" />
    </div>
  );
}

/** what closed the ask, when it was not an answer */
export const CLOSED: Record<string, string> = {
  skipped: "you skipped this",
  cancelled: "the turn was stopped before you answered",
  expired: "Toyon restarted before you answered",
};
