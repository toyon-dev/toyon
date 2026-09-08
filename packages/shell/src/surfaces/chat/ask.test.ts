import { describe, expect, test } from "bun:test";
import type { AskQuestion } from "@toyon/shared";
import { answerText, askRows, canSubmit, choose, emptyDraft, nextQuestionRow, rowForDigit, setNote } from "./ask.ts";

const q = (id: string, labels: string[], extra: Partial<AskQuestion> = {}): AskQuestion => ({
  id,
  text: id,
  options: labels.map((l) => ({ value: l.toLowerCase(), label: l })),
  ...extra,
});

const one = [q("auth", ["Cookies", "JWT"])];
const two = [q("auth", ["Cookies", "JWT"]), q("store", ["Postgres", "SQLite", "MySQL"])];

describe("askRows", () => {
  test("flattens every question's options in order, so one list walks the whole card", () => {
    expect(askRows(two).map((r) => `${r.q}:${r.option.label}`)).toEqual([
      "0:Cookies",
      "0:JWT",
      "1:Postgres",
      "1:SQLite",
      "1:MySQL",
    ]);
  });
});

describe("choose", () => {
  test("single-select replaces", () => {
    const rows = askRows(one);
    let d = emptyDraft(one);
    d = choose(d, rows[0]!, false);
    d = choose(d, rows[1]!, false);
    expect(d[0]!.selected).toEqual(["jwt"]);
  });

  test("multi-select toggles, and a second press takes it back off", () => {
    const rows = askRows(one);
    let d = emptyDraft(one);
    d = choose(d, rows[0]!, true);
    d = choose(d, rows[1]!, true);
    expect(d[0]!.selected).toEqual(["cookies", "jwt"]);
    d = choose(d, rows[0]!, true);
    expect(d[0]!.selected).toEqual(["jwt"]);
  });

  test("a pick only touches its own question", () => {
    const rows = askRows(two);
    let d = emptyDraft(two);
    d = choose(d, rows[1]!, false);
    d = choose(d, rows[3]!, false);
    expect(d).toEqual([{ selected: ["jwt"] }, { selected: ["sqlite"] }]);
  });
});

describe("canSubmit", () => {
  test("a card with nothing required can always go back: skipping a question is an answer", () => {
    expect(canSubmit(two, emptyDraft(two))).toBe(true);
  });

  test("a required question needs a pick, and a note counts as one", () => {
    const req = [q("auth", ["Cookies", "JWT"], { required: true })];
    expect(canSubmit(req, emptyDraft(req))).toBe(false);
    expect(canSubmit(req, choose(emptyDraft(req), askRows(req)[0]!, false))).toBe(true);
    expect(canSubmit(req, setNote(emptyDraft(req), 0, "neither"))).toBe(true);
    // whitespace is not an answer
    expect(canSubmit(req, setNote(emptyDraft(req), 0, "   "))).toBe(false);
  });
});

describe("the keyboard's view of the card", () => {
  test("a digit means the nth option of the question the highlight is in", () => {
    const rows = askRows(two);
    expect(rowForDigit(rows, 0, 2)).toBe(1);
    // highlight inside the second question: 2 is SQLite, not JWT
    expect(rowForDigit(rows, 2, 2)).toBe(3);
    expect(rowForDigit(rows, 2, 9)).toBe(-1);
  });

  test("a single-select pick moves on to the next question", () => {
    const rows = askRows(two);
    expect(nextQuestionRow(rows, 0)).toBe(2);
    // the last question has nowhere to go, so the highlight stays put
    expect(nextQuestionRow(rows, 3)).toBe(3);
  });
});

describe("answerText", () => {
  test("reads a multi-select back as a list, and a note as the caveat on it", () => {
    expect(answerText(one[0]!, { selected: ["cookies", "jwt"] })).toBe("Cookies, JWT");
    expect(answerText(one[0]!, { selected: ["jwt"], note: "for now" })).toBe("JWT: for now");
    expect(answerText(one[0]!, { selected: [], note: "neither" })).toBe("neither");
    expect(answerText(one[0]!, { selected: [] })).toBe("skipped");
    expect(answerText(one[0]!, undefined)).toBe("skipped");
  });
});
