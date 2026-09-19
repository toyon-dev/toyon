// The logic behind the ask in the composer, kept out of the component so it can be tested without
// a DOM. An ask holds up to four questions and is answered in one go, because the wire is one
// request with one response; the box shows one question at a time and the keyboard walks them.

import type { AskAnswer, AskOption, AskQuestion } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";

export type AskItem = Extract<ChatItem, { kind: "ask" }>;

/** the ask the box shows: the newest one nothing has closed, or none */
export function openAsk(chat: ChatItem[]): AskItem | null {
  const item = chat.findLast((i) => i.kind === "ask" && !i.outcome);
  return item?.kind === "ask" ? item : null;
}

/** what the transcript row says while the ask is open: the questions by their headers, else the
 * message they came with; a permission by its title */
export function askLine(item: AskItem): string {
  if (item.ask.kind === "permission") return item.ask.title;
  const headers = item.ask.questions.map((q) => q.header).filter((h): h is string => !!h);
  return headers.length > 0 ? headers.join(", ") : item.ask.message;
}

/** answers in the ask's own order, so an empty draft is still one entry per question */
export function emptyDraft(questions: AskQuestion[]): AskAnswer[] {
  return questions.map(() => ({ selected: [] }));
}

/** multi-select toggles; single-select replaces */
export function choose(draft: AskAnswer[], q: number, value: string, multi: boolean): AskAnswer[] {
  return draft.map((a, i) => {
    if (i !== q) return a;
    const has = a.selected.includes(value);
    if (!multi) return { ...a, selected: [value] };
    return { ...a, selected: has ? a.selected.filter((v) => v !== value) : [...a.selected, value] };
  });
}

export function setNote(draft: AskAnswer[], q: number, note: string): AskAnswer[] {
  return draft.map((a, i) => (i === q ? { ...a, note } : a));
}

/** a pick, or something typed as the person's own answer */
export function answered(a: AskAnswer | undefined): boolean {
  return !!a && (a.selected.length > 0 || !!a.note?.trim());
}

/** a question the agent marked required needs a pick or a note before the ask can go back */
export function canSubmit(questions: AskQuestion[], draft: AskAnswer[]): boolean {
  return questions.every((q, i) => !q.required || answered(draft[i]));
}

/** the answer as the transcript reads it back once the ask is closed */
export function answerText(q: AskQuestion, a: AskAnswer | undefined): string {
  const labels = (a?.selected ?? []).map((v) => q.options.find((o) => o.value === v)?.label ?? v);
  const note = a?.note?.trim();
  if (labels.length === 0) return note || "skipped";
  return note ? `${labels.join(", ")}: ${note}` : labels.join(", ");
}

/** the option a digit means: the nth of the question on screen */
export function optionForDigit(q: AskQuestion | undefined, digit: number): AskOption | undefined {
  return q?.options[digit - 1];
}

/** where the cursor lands on arriving at a question: its pick, else its first option */
export function cursorFor(q: AskQuestion | undefined, a: AskAnswer | undefined): number {
  if (!q) return 0;
  const at = a?.selected[0] ? q.options.findIndex((o) => o.value === a.selected[0]) : -1;
  return at === -1 ? 0 : at;
}

/** the next question after `from` with no answer yet, wrapping round, or -1 when every one has
 * one: the questions are answered in whatever order they were reached, so what is left is the
 * only thing worth walking to */
export function nextUnanswered(questions: AskQuestion[], draft: AskAnswer[], from: number): number {
  const n = questions.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (!answered(draft[i])) return i;
  }
  return -1;
}

/** where the box goes after a single-select pick: on to the next question still unanswered, its
 * cursor on that question's pick, or, with none left, stay put and send. One question is the
 * common shape, and asking for a second keystroke there would be theatre. */
export function advance(
  questions: AskQuestion[],
  draft: AskAnswer[],
  from: number,
): { current: number; cursor: number; send: boolean } {
  const next = nextUnanswered(questions, draft, from);
  if (next === -1) return { current: from, cursor: cursorFor(questions[from], draft[from]), send: true };
  return { current: next, cursor: cursorFor(questions[next], draft[next]), send: false };
}

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** the agent's convention for the option it would pick: a suffix on the label, which the row
 * draws as a badge instead */
export function recommended(label: string): boolean {
  return RECOMMENDED.test(label);
}

export function stripRecommended(label: string): string {
  return label.replace(RECOMMENDED, "");
}
