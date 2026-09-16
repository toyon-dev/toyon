// The agent asked something and its turn is stopped until this is answered. Two bodies behind one
// shell: a question (options, a note, one send for the whole card) and a permission (the agent's
// own options, one click each).
//
// The card takes focus when it arrives, because nothing else in the worktree is useful while the
// agent is blocked, and a message typed meanwhile reaches the adapter without cancelling anything.
// Escape hands focus back and leaves the card open. Every key has a button behind it: the digit
// and the click run the same handler, so nothing here is keyboard-only.

import type { AskAnswer, AskQuestion } from "@toyon/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSock, useStore } from "../../state/context.tsx";
import type { ChatItem } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { TextArea } from "../../ui/Field.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { KeyHints } from "../../ui/KeyHints.tsx";
import { useListNav } from "../../ui/listNav.ts";
import { rowState } from "../../ui/rowState.ts";
import {
  activeQuestion,
  answerText,
  askRows,
  canSubmit,
  choose,
  emptyDraft,
  nextQuestionRow,
  rowForDigit,
  rowKey,
  setNote,
} from "./ask.ts";
import { renderMarkdown } from "./markdown.ts";

type Ask = Extract<ChatItem, { kind: "ask" }>;

/** the same key row a picker draws under its rows: one hint per cell, so a verb never breaks away
 * from the key it belongs to when the card is narrow */
const KEYS: Array<[string, string]> = [
  ["↑↓", "move"],
  ["⏎", "choose"],
  ["⌘⏎", "send"],
  ["esc", "back to the message box"],
];

const CLOSED: Record<string, string> = {
  skipped: "you skipped this",
  cancelled: "the turn was stopped before you answered",
  expired: "Toyon restarted before you answered",
};

export function AskCard({ item }: { item: Ask }) {
  return item.ask.kind === "question" ? (
    <QuestionBody item={item} ask={item.ask} />
  ) : (
    <PermissionBody item={item} ask={item.ask} />
  );
}

/** The card is the focused element and reads its own keys, so each body owns the div rather than
 * sharing one: the two want different keys, and only the element with focus can take them. */
function useAskFocus(open: boolean) {
  const card = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (!open) return;
    // rAF because the row is painted in the same commit that appends it
    const f = requestAnimationFrame(() => {
      card.current?.focus();
      card.current?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(f);
  }, [open]);
  return card;
}

/** blur back to the composer; the card stays open, because it is still what the agent waits on */
function releaseFocus(card: React.RefObject<HTMLFieldSetElement | null>) {
  card.current?.blur();
  document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
}

function QuestionBody({ item, ask }: { item: Ask; ask: Extract<Ask["ask"], { kind: "question" }> }) {
  const open = !item.outcome;
  const card = useAskFocus(open);
  const sock = useSock();
  const worktreeId = useStore((s) => s.activeId);
  const { message, questions } = ask;
  const rows = useMemo(() => askRows(questions), [questions]);
  const [draft, setDraft] = useState<AskAnswer[]>(() => emptyDraft(questions));
  const [noteFor, setNoteFor] = useState<number | null>(null);

  const nav = useListNav<(typeof rows)[number]>({
    results: rows,
    keyOf: rowKey,
    q: "",
    listRef: card,
    onPick: (row) => pick(row),
  });

  const pick = (row: (typeof rows)[number]) => {
    const q = questions[row.q];
    if (!q) return;
    setDraft((d) => choose(d, row, !!q.multi));
    if (!q.multi) nav.setIndex(nextQuestionRow(rows, rows.indexOf(row)));
  };

  const send = (answers?: AskAnswer[]) => {
    if (!worktreeId || !open) return;
    sock?.send({ t: "agent-answer", worktreeId, askId: item.id, ...(answers ? { answers } : {}) });
  };
  const submit = () => {
    if (canSubmit(questions, draft)) send(draft);
  };

  if (!open) return <Closed item={item} lead={message} questions={questions} />;

  const current = activeQuestion(rows, nav.index);
  const currentQ = questions[current];

  const onKeyDown = (e: React.KeyboardEvent) => {
    // the note box reads its own keys; everything else in the card belongs to this handler,
    // including a button the mouse just focused
    if (e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return releaseFocus(card);
    }
    if ((e.key === "Enter" || e.key === "NumpadEnter") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      return submit();
    }
    if (e.key === "Enter" && nav.active) {
      e.preventDefault();
      pick(nav.active);
      // one single-select question is the common shape, and asking for a second keystroke there
      // would be theatre
      if (questions.length === 1 && !questions[0]?.multi && noteFor === null) send(choose(draft, nav.active, false));
      return;
    }
    if (e.key === " " && currentQ?.multi && nav.active) {
      e.preventDefault();
      return pick(nav.active);
    }
    if (e.key === "n" && currentQ?.note) {
      e.preventDefault();
      return setNoteFor(current);
    }
    if (e.key === "s") {
      e.preventDefault();
      return send();
    }
    if (e.key >= "1" && e.key <= "9") {
      const at = rowForDigit(rows, nav.index, Number(e.key));
      if (at === -1) return;
      e.preventDefault();
      nav.setIndex(at);
      return pick(rows[at]!);
    }
    nav.onKeyDown(e);
  };

  return (
    <fieldset ref={card} className="ask-card" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="ask-lead">{message}</div>
      {questions.map((q, qi) => (
        <div className="ask-block" key={q.id}>
          {q.header && <div className="ask-header">{q.header}</div>}
          {q.text && q.text !== message && <div className="ask-text">{q.text}</div>}
          <div className="ask-options">
            {q.options.map((o, oi) => {
              const at = rows.findIndex((r) => r.q === qi && r.option.value === o.value);
              const on = draft[qi]?.selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  className="picker-item picker-row ask-opt row-edge"
                  data-state={rowState({ cursor: at === nav.index, checked: on })}
                  // mousemove, not mouseenter, for the same reason the picker gives: a row arriving
                  // under a stationary pointer must not steal the highlight the keyboard is on
                  onMouseMove={() => at !== nav.index && nav.setIndex(at)}
                  onClick={() => {
                    nav.setIndex(at);
                    pick(rows[at]!);
                    card.current?.focus();
                  }}
                >
                  <Kbd k={String(oi + 1)} className="ask-num row-dim" />
                  <span className="picker-name">{o.label}</span>
                  {o.description && <span className="picker-desc row-dim">{o.description}</span>}
                </button>
              );
            })}
          </div>
          {nav.active?.q === qi && nav.active.option.preview && (
            <pre className="ask-preview">{nav.active.option.preview}</pre>
          )}
          {q.note && noteFor !== qi && (
            <Button tone="quiet" onClick={() => setNoteFor(qi)}>
              <Kbd k="n" chip />
              {draft[qi]?.note?.trim() ? "edit your note" : "add a note"}
            </Button>
          )}
          {q.note && noteFor === qi && (
            <TextArea
              font="ui"
              className="ask-note"
              autoFocus
              rows={2}
              placeholder={`${q.note.label}: goes to the agent with your pick`}
              value={draft[qi]?.note ?? ""}
              onChange={(e) => setDraft((d) => setNote(d, qi, e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setNoteFor(null);
                  card.current?.focus();
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          )}
        </div>
      ))}
      <div className="ask-foot">
        <Button variant="outline" size="md" disabled={!canSubmit(questions, draft)} onClick={submit}>
          send
        </Button>
        <Button tone="quiet" size="md" onClick={() => send()}>
          <Kbd k="s" chip />
          skip
        </Button>
      </div>
      <KeyHints hints={KEYS} className="ask-keys" />
    </fieldset>
  );
}

function PermissionBody({ item, ask }: { item: Ask; ask: Extract<Ask["ask"], { kind: "permission" }> }) {
  const open = !item.outcome;
  const card = useAskFocus(open);
  const sock = useSock();
  const worktreeId = useStore((s) => s.activeId);
  const html = useMemo(() => (ask.detail ? renderMarkdown(ask.detail) : ""), [ask.detail]);
  const decide = (choiceId: string) => {
    if (worktreeId && open) sock?.send({ t: "agent-decide", worktreeId, askId: item.id, choiceId });
  };

  const chosen = ask.choices.find((c) => c.id === item.choiceId);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return releaseFocus(card);
    }
    if (e.key >= "1" && e.key <= "9") {
      const choice = ask.choices[Number(e.key) - 1];
      if (!choice) return;
      e.preventDefault();
      decide(choice.id);
    }
  };

  return (
    <fieldset ref={card} className={`ask-card ${open ? "" : "done"}`} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="ask-lead">{ask.title}</div>
      {html && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown
        <div className="ask-detail md" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {open ? (
        <div className="ask-options">
          {ask.choices.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={`picker-item picker-row ask-opt row-edge ${c.kind.startsWith("reject") ? "deny" : ""}`}
              onClick={() => decide(c.id)}
            >
              <Kbd k={String(i + 1)} className="ask-num row-dim" />
              <span className="picker-name">{c.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="ask-answered">{chosen ? chosen.name : (CLOSED[item.outcome ?? ""] ?? "closed")}</div>
      )}
    </fieldset>
  );
}

function Closed({ item, lead, questions }: { item: Ask; lead: string; questions: AskQuestion[] }) {
  const note = CLOSED[item.outcome ?? ""];
  return (
    <div>
      <div className="ask-lead">{lead}</div>
      {note ? (
        <div className="ask-answered">{note}</div>
      ) : (
        questions.map((q, i) => (
          <div className="ask-answered" key={q.id}>
            {q.header && <span className="ask-header">{q.header}</span>}
            {answerText(q, item.answers?.[i])}
          </div>
        ))
      )}
    </div>
  );
}
