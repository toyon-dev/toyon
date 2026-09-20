// The logic behind the ask in the composer, kept out of the component so it can be tested without
// a DOM. An ask holds up to four questions and is answered in one go, because the wire is one
// request with one response; the box shows one question at a time and the keyboard walks them.

import type { AskAnswer, AskQuestion } from "@toyon/shared";
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

/** undefined takes the note away, and with it the field it is typed in */
export function setNote(draft: AskAnswer[], q: number, note: string | undefined): AskAnswer[] {
  return draft.map((a, i) => {
    if (i !== q) return a;
    const { note: _, ...rest } = a;
    return note === undefined ? rest : { ...rest, note };
  });
}

/** The typed answer is reached two ways, and both open the same field, since the wire has one
 * free-text slot per question: the agent reads it as the answer when nothing is picked and as a
 * caveat on the pick when something is. `own` is the "other" row, so a single pick is dropped for
 * it; a note (`n`) keeps the pick and rides with it. A multi-select keeps its picks either way. */
export function openNote(draft: AskAnswer[], q: number, own: boolean, multi: boolean): AskAnswer[] {
  return draft.map((a, i) => {
    if (i !== q) return a;
    return { selected: own && !multi ? [] : a.selected, note: a.note ?? "" };
  });
}

/** a field opened and left blank closes again: nothing was said, so nothing is shown */
export function dropBlankNote(draft: AskAnswer[], q: number): AskAnswer[] {
  const a = draft[q];
  return a && a.note !== undefined && !a.note.trim() ? setNote(draft, q, undefined) : draft;
}

/** the rows the keyboard walks: the options, then the "other" row when the agent takes typed text */
export function rowsOf(q: AskQuestion | undefined): number {
  return q ? q.options.length + (q.note ? 1 : 0) : 0;
}

export function isOwnRow(q: AskQuestion | undefined, i: number): boolean {
  return !!q?.note && i === q.options.length;
}

/** the "other" row wears the check while the typed answer stands in for a pick: the field is open
 * and, in a single-select, nothing else is chosen */
export function ownChosen(a: AskAnswer | undefined, multi: boolean): boolean {
  return !!a && a.note !== undefined && (multi || a.selected.length === 0);
}

/** a pick, or something typed as the person's own answer */
export function answered(a: AskAnswer | undefined): boolean {
  return !!a && (a.selected.length > 0 || !!a.note?.trim());
}

/** a question the agent marked required needs a pick or a note before the ask can go back */
export function canSubmit(questions: AskQuestion[], draft: AskAnswer[]): boolean {
  return questions.every((q, i) => !q.required || answered(draft[i]));
}

/** the answer as it reads back, on the send page and in the transcript once the ask is closed. The
 * agent's "(Recommended)" suffix was the box's badge, not part of the label, so it is not read back. */
export function answerText(q: AskQuestion, a: AskAnswer | undefined): string {
  const labels = (a?.selected ?? []).map((v) => stripRecommended(q.options.find((o) => o.value === v)?.label ?? v));
  const note = a?.note?.trim();
  if (labels.length === 0) return note || "skipped";
  return note ? `${labels.join(", ")}: ${note}` : labels.join(", ");
}

/** the row a digit means: the nth of the question on screen, the "other" row counted, or -1 */
export function rowForDigit(q: AskQuestion | undefined, digit: number): number {
  return digit >= 1 && digit <= rowsOf(q) ? digit - 1 : -1;
}

/** where the cursor lands on arriving at a question: its pick, the "other" row when the typed
 * answer is the pick, else its first option */
export function cursorFor(q: AskQuestion | undefined, a: AskAnswer | undefined): number {
  if (!q) return 0;
  if (ownChosen(a, !!q.multi) && q.note) return q.options.length;
  const at = a?.selected[0] ? q.options.findIndex((o) => o.value === a.selected[0]) : -1;
  return at === -1 ? 0 : at;
}

/** ←→ between questions stop at the ends: the strip is a row of tabs, and a tab strip does not
 * come round, so the key that reached the last one is the key that stays there */
export function walk(current: number, delta: number, n: number): number {
  return Math.max(0, Math.min(n - 1, current + delta));
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

/** the page after the questions, when there is more than one: the answers read back together, and
 * the send. A lone question has no strip and no such page, since its pick is its send. */
export function sendPage(questions: AskQuestion[]): number {
  return questions.length > 1 ? questions.length : -1;
}

/** how many pages the arrows walk: the questions, and the send page when there is one */
export function pageCount(questions: AskQuestion[]): number {
  return questions.length + (sendPage(questions) === -1 ? 0 : 1);
}

/** where the box goes after a single-select pick: on to the next question still unanswered, its
 * cursor on that question's pick, or, with none left, to the send page, where the answers are read
 * back before they go. One question is the common shape and has no such page: asking for a second
 * keystroke there would be theatre, so the last pick is the send. */
export function advance(
  questions: AskQuestion[],
  draft: AskAnswer[],
  from: number,
): { current: number; cursor: number; send: boolean } {
  const next = nextUnanswered(questions, draft, from);
  if (next !== -1) return { current: next, cursor: cursorFor(questions[next], draft[next]), send: false };
  const review = sendPage(questions);
  if (review !== -1) return { current: review, cursor: 0, send: false };
  return { current: from, cursor: cursorFor(questions[from], draft[from]), send: true };
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
