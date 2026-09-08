// The logic behind the ask card, kept out of the component so it can be tested without a DOM.
// A card holds up to four questions and is answered in one go, because the wire is one request
// with one response.

import type { AskAnswer, AskOption, AskQuestion } from "@toyon/shared";

/** one option of one question. The card flattens every question's options into a single list so
 * one useListNav can walk the whole card: hooks cannot be looped per question. */
export interface AskRow {
  q: number;
  option: AskOption;
}

export function askRows(questions: AskQuestion[]): AskRow[] {
  return questions.flatMap((q, i) => q.options.map((option) => ({ q: i, option })));
}

export function rowKey(row: AskRow): string {
  return `${row.q}:${row.option.value}`;
}

/** answers in the card's own order, so an empty draft is still one entry per question */
export function emptyDraft(questions: AskQuestion[]): AskAnswer[] {
  return questions.map(() => ({ selected: [] }));
}

/** multi-select toggles; single-select replaces */
export function choose(draft: AskAnswer[], row: AskRow, multi: boolean): AskAnswer[] {
  return draft.map((a, i) => {
    if (i !== row.q) return a;
    const has = a.selected.includes(row.option.value);
    if (!multi) return { ...a, selected: [row.option.value] };
    return {
      ...a,
      selected: has ? a.selected.filter((v) => v !== row.option.value) : [...a.selected, row.option.value],
    };
  });
}

export function setNote(draft: AskAnswer[], q: number, note: string): AskAnswer[] {
  return draft.map((a, i) => (i === q ? { ...a, note } : a));
}

function answered(a: AskAnswer | undefined): boolean {
  return !!a && (a.selected.length > 0 || !!a.note?.trim());
}

/** a question the agent marked required needs a pick or a note before the card can go back */
export function canSubmit(questions: AskQuestion[], draft: AskAnswer[]): boolean {
  return questions.every((q, i) => !q.required || answered(draft[i]));
}

/** the answer as the card reads it back once it is closed */
export function answerText(q: AskQuestion, a: AskAnswer | undefined): string {
  const labels = (a?.selected ?? []).map((v) => q.options.find((o) => o.value === v)?.label ?? v);
  const note = a?.note?.trim();
  if (labels.length === 0) return note || "skipped";
  return note ? `${labels.join(", ")}: ${note}` : labels.join(", ");
}

/** the question the highlight is in, so `n` and the digits know what they act on */
export function activeQuestion(rows: AskRow[], index: number): number {
  return rows[index]?.q ?? 0;
}

/** the row a digit means: the nth option of the question the highlight is in */
export function rowForDigit(rows: AskRow[], index: number, digit: number): number {
  const q = activeQuestion(rows, index);
  const inQuestion = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.q === q);
  return inQuestion[digit - 1]?.i ?? -1;
}

/** where the highlight goes after a single-select pick: the next question's first option, so a
 * card of three questions answers as three keystrokes and a send */
export function nextQuestionRow(rows: AskRow[], index: number): number {
  const q = activeQuestion(rows, index);
  const at = rows.findIndex((r) => r.q > q);
  return at === -1 ? index : at;
}
