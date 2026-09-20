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
import { Icon } from "../../ui/Icon.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { KeyHints } from "../../ui/KeyHints.tsx";
import { step } from "../../ui/listNav.ts";
import { rowState } from "../../ui/rowState.ts";
import { Tabs } from "../../ui/Tabs.tsx";
import {
  type AskItem,
  advance,
  answered,
  answerText,
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
  rowForDigit,
  rowsOf,
  sendPage,
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
  // the page after the questions, where they read back before they go; no question is open there
  const review = current === sendPage(questions);
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
      // on the send page enter is the send: the answers are read back above it, and this is the
      // keystroke the page was walked to for
      return review ? submit() : pick(cursor);
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (!q) return;
      return setCursor(step(cursor, e.key === "ArrowUp" ? -1 : 1, rowsOf(q)));
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Tab") {
      e.preventDefault();
      const back = e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey);
      return go(walk(current, back ? -1 : 1, pageCount(questions)));
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
      // the send page's rows are the questions, numbered the way the options are, and the digit
      // opens that question the way it picks an option
      const row = review ? (Number(e.key) <= questions.length ? Number(e.key) - 1 : -1) : rowForDigit(q, Number(e.key));
      if (row === -1) return;
      e.preventDefault();
      return review ? go(row) : pick(row);
    }
  };

  /** the key strip of a page, the send page's when no question is given. Each page carries its
   * own rather than the open page's, since a hidden page's strip still sets its height, and a
   * strip that wrapped on one page and not another moved the box with the tab. */
  const hintsFor = (qq?: (typeof questions)[number]): Array<[string, string]> =>
    qq
      ? [
          ...(questions.length > 1 ? [["←→", "question"] as [string, string]] : []),
          ["↑↓", "move"],
          ["⏎", "choose"],
          ...(qq.note ? [["n", "add a note"] as [string, string]] : []),
          ["⌘⏎", "send"],
          ["esc", "reply instead"],
        ]
      : [
          ["←→", "question"],
          ["⏎", "send"],
          ["esc", "reply instead"],
        ];

  /** the actions under a page: the send, the note on the pick where the agent takes one and a
   * pick is made, the skip, and the stop at the far end. Each page carries its own, and the key
   * strip after it, so the page's height is the whole of what shows for it; the foot sits at the
   * page's floor so the send is in one place whichever page is open. */
  const foot = (qq?: (typeof questions)[number], a?: AskAnswer) => (
    <div className="ask-foot">
      <Button variant="outline" size="md" disabled={!canSubmit(questions, draft)} onClick={submit}>
        send
      </Button>
      {qq?.note && a && a.selected.length > 0 && a.note === undefined && (
        <Button tone="quiet" size="md" onClick={() => type(false)}>
          <Kbd k="n" chip />
          add a note
        </Button>
      )}
      <Button tone="quiet" size="md" onClick={() => send()}>
        <Kbd k="s" chip />
        skip
      </Button>
      <Button
        variant="outline"
        tone="danger"
        size="md"
        className="ask-stop"
        data-tip="Stop the agent (context up to here is kept)"
        onClick={() => sock?.send({ t: "stop-agent", worktreeId })}
      >
        <Icon name="stop" className="icon-inline" /> stop
      </Button>
    </div>
  );

  /** one question's page: its text, its options, the "other" row, the typed answer's field once
   * opened, and its own foot and key strip. Every page is in the DOM so the box stands at the
   * tallest one's height; only the open page has the cursor, the preview and the field's ref. */
  const page = (qq: (typeof questions)[number], i: number) => {
    const open = i === current;
    const a = draft[i];
    const owning = ownChosen(a, !!qq.multi);
    const under = open ? qq.options[cursor] : undefined;
    return (
      <div key={qq.id} className={cx("ask-page", !open && "ask-page-off")}>
        <div className="ask-head">
          <div className="ask-text">{qq.text || message}</div>
        </div>
        <div className="ask-options">
          {qq.options.map((o, oi) => {
            const on = a?.selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                className="picker-item ask-opt row-edge"
                data-state={rowState({ cursor: open && !touch && oi === cursor, checked: on })}
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
          {qq.note && (
            <button
              type="button"
              className="picker-item ask-opt row-edge"
              data-state={rowState({ cursor: open && !touch && cursor === qq.options.length, checked: owning })}
              onMouseMove={() => cursor !== qq.options.length && setCursor(qq.options.length)}
              onClick={() => pick(qq.options.length)}
            >
              <Kbd k={String(qq.options.length + 1)} className="ask-num row-dim" />
              <span className="ask-label">{qq.note.label}</span>
              <span className="ask-desc row-dim">your own answer</span>
            </button>
          )}
        </div>
        {under?.preview && <pre className="ask-preview">{under.preview}</pre>}
        {qq.note && a?.note !== undefined && (
          <TextArea
            ref={open ? own : undefined}
            bare
            font="ui"
            rows={2}
            className="ask-own"
            placeholder={owning ? `${qq.note.label}: your own answer` : "a note for the agent, sent with your pick"}
            value={a.note}
            onChange={(e) => write(setNote(draft, i, e.target.value), i)}
          />
        )}
        {foot(qq, a)}
        <KeyHints hints={hintsFor(qq)} className="ask-keys" />
      </div>
    );
  };

  return (
    <div ref={root} className="ask-box" tabIndex={-1} onKeyDown={onKeyDown} onBlur={onBlur}>
      {/* the questions as tabs across the top: the headers are the agent's short names for them,
          and the one open joins the page under it. A dot on each says which are answered. The
          send stands apart at the far end: it is the step after the questions, not one of them. */}
      {questions.length > 1 && (
        <div className="ask-tabs">
          <Tabs
            label="questions"
            owner="ask"
            items={[
              ...questions.map((qq, i) => ({
                id: String(i),
                label: qq.header || `question ${i + 1}`,
                lead: <span className={cx("dot ask-step", answered(draft[i]) && "answered")} />,
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
      <div className="ask-pages">
        {questions.map(page)}
        {sendPage(questions) !== -1 && (
          <div className={cx("ask-page", !review && "ask-page-off")}>
            <div className="ask-head">
              <div className="ask-text">Send these answers?</div>
            </div>
            <div className="ask-options">
              {questions.map((qq, i) => {
                const has = answered(draft[i]);
                return (
                  <button
                    key={qq.id}
                    type="button"
                    className="picker-item ask-opt ask-sum"
                    onClick={() => {
                      go(i);
                      root.current?.focus();
                    }}
                  >
                    <Kbd k={String(i + 1)} className="ask-num row-dim" />
                    <span className="ask-label">
                      <span className="row-dim">{qq.header || `question ${i + 1}`}</span>{" "}
                      <span className={cx(!has && "row-dim")}>{has ? answerText(qq, draft[i]) : "no answer yet"}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {foot()}
            <KeyHints hints={hintsFor()} className="ask-keys" />
          </div>
        )}
      </div>
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
