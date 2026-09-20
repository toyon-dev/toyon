import { describe, expect, test } from "bun:test";
import type { AskQuestion } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";
import {
  advance,
  answerText,
  askLine,
  canSubmit,
  choose,
  cursorFor,
  dropBlankNote,
  emptyDraft,
  isOwnRow,
  nextUnanswered,
  openAsk,
  openNote,
  ownChosen,
  recommended,
  rowForDigit,
  rowsOf,
  setNote,
  stripRecommended,
  walk,
} from "./ask.ts";

const q = (id: string, labels: string[], extra: Partial<AskQuestion> = {}): AskQuestion => ({
  id,
  text: id,
  options: labels.map((l) => ({ value: l.toLowerCase(), label: l })),
  ...extra,
});

const one = [q("auth", ["Cookies", "JWT"])];
const two = [q("auth", ["Cookies", "JWT"]), q("store", ["Postgres", "SQLite", "MySQL"])];
const three = [...two, q("cache", ["Redis", "None"])];

describe("openAsk", () => {
  test("is the newest ask nothing has closed", () => {
    const chat: ChatItem[] = [
      { kind: "ask", id: "k1", ask: { kind: "question", message: "Which?", questions: one }, outcome: "answered" },
      { kind: "ask", id: "k2", ask: { kind: "question", message: "And?", questions: one } },
      { kind: "assistant", text: "…" },
    ];
    expect(openAsk(chat)?.id).toBe("k2");
    expect(openAsk(chat.slice(0, 1))).toBeNull();
    expect(openAsk([])).toBeNull();
  });
});

describe("askLine", () => {
  test("names the questions by their headers, else the message, and a permission by its title", () => {
    const headed = [q("a", ["x"], { header: "Auto-pull" }), q("b", ["y"], { header: "Main's seat" }), q("c", ["z"])];
    expect(
      askLine({ kind: "ask", id: "k", ask: { kind: "question", message: "Please answer.", questions: headed } }),
    ).toBe("Auto-pull, Main's seat");
    expect(askLine({ kind: "ask", id: "k", ask: { kind: "question", message: "Which port?", questions: one } })).toBe(
      "Which port?",
    );
    expect(askLine({ kind: "ask", id: "k", ask: { kind: "permission", title: "Approve the plan", choices: [] } })).toBe(
      "Approve the plan",
    );
  });
});

describe("choose", () => {
  test("single-select replaces", () => {
    let d = emptyDraft(one);
    d = choose(d, 0, "cookies", false);
    d = choose(d, 0, "jwt", false);
    expect(d[0]!.selected).toEqual(["jwt"]);
  });

  test("multi-select toggles, and a second press takes it back off", () => {
    let d = emptyDraft(one);
    d = choose(d, 0, "cookies", true);
    d = choose(d, 0, "jwt", true);
    expect(d[0]!.selected).toEqual(["cookies", "jwt"]);
    d = choose(d, 0, "cookies", true);
    expect(d[0]!.selected).toEqual(["jwt"]);
  });

  test("a pick only touches its own question", () => {
    let d = emptyDraft(two);
    d = choose(d, 0, "jwt", false);
    d = choose(d, 1, "sqlite", false);
    expect(d).toEqual([{ selected: ["jwt"] }, { selected: ["sqlite"] }]);
  });
});

describe("canSubmit", () => {
  test("an ask with nothing required can always go back: skipping a question is an answer", () => {
    expect(canSubmit(two, emptyDraft(two))).toBe(true);
  });

  test("a required question needs a pick, and a note counts as one", () => {
    const req = [q("auth", ["Cookies", "JWT"], { required: true })];
    expect(canSubmit(req, emptyDraft(req))).toBe(false);
    expect(canSubmit(req, choose(emptyDraft(req), 0, "jwt", false))).toBe(true);
    expect(canSubmit(req, setNote(emptyDraft(req), 0, "neither"))).toBe(true);
    // whitespace is not an answer
    expect(canSubmit(req, setNote(emptyDraft(req), 0, "   "))).toBe(false);
  });
});

describe("the typed answer", () => {
  const noted = q("auth", ["Cookies", "JWT"], { note: { label: "Other" } });
  const multi = q("auth", ["Cookies", "JWT"], { note: { label: "Other" }, multi: true });

  test("the other row comes after the options, only when the agent takes typed text", () => {
    expect(rowsOf(noted)).toBe(3);
    expect(rowsOf(one[0])).toBe(2);
    expect(rowsOf(undefined)).toBe(0);
    expect(isOwnRow(noted, 2)).toBe(true);
    expect(isOwnRow(noted, 1)).toBe(false);
    expect(isOwnRow(one[0], 2)).toBe(false);
  });

  test("the other row drops a single pick; a note keeps it; a multi-select keeps its picks either way", () => {
    const picked = choose(emptyDraft([noted]), 0, "jwt", false);
    expect(openNote(picked, 0, true, false)).toEqual([{ selected: [], note: "" }]);
    expect(openNote(picked, 0, false, false)).toEqual([{ selected: ["jwt"], note: "" }]);
    expect(openNote(picked, 0, true, true)).toEqual([{ selected: ["jwt"], note: "" }]);
    // reopening keeps what was typed
    expect(openNote(setNote(picked, 0, "why"), 0, false, false)).toEqual([{ selected: ["jwt"], note: "why" }]);
  });

  test("the other row is the pick while the field is open with nothing else chosen", () => {
    expect(ownChosen({ selected: [], note: "" }, false)).toBe(true);
    expect(ownChosen({ selected: ["jwt"], note: "" }, false)).toBe(false);
    expect(ownChosen({ selected: ["jwt"], note: "" }, true)).toBe(true);
    expect(ownChosen({ selected: [] }, false)).toBe(false);
    expect(ownChosen(undefined, false)).toBe(false);
    expect(cursorFor(noted, { selected: [], note: "" })).toBe(2);
    expect(cursorFor(multi, { selected: ["jwt"], note: "x" })).toBe(2);
  });

  test("a field left blank closes; one written in stays", () => {
    const open = openNote(emptyDraft([noted]), 0, true, false);
    expect(dropBlankNote(open, 0)).toEqual([{ selected: [] }]);
    expect(dropBlankNote(setNote(open, 0, "  "), 0)).toEqual([{ selected: [] }]);
    const written = setNote(open, 0, "neither");
    expect(dropBlankNote(written, 0)).toBe(written);
    expect(dropBlankNote(emptyDraft([noted]), 0)).toEqual([{ selected: [] }]);
  });

  test("taking the note away leaves no key behind", () => {
    expect(setNote([{ selected: ["a"], note: "x" }], 0, undefined)).toEqual([{ selected: ["a"] }]);
    expect(Object.keys(setNote([{ selected: ["a"], note: "x" }], 0, undefined)[0]!)).toEqual(["selected"]);
  });
});

describe("the keyboard's view of the ask", () => {
  test("a digit means the nth row of the question on screen, the other row counted", () => {
    expect(rowForDigit(two[1], 2)).toBe(1);
    expect(rowForDigit(two[1], 4)).toBe(-1);
    expect(rowForDigit(two[1], 0)).toBe(-1);
    expect(rowForDigit(undefined, 1)).toBe(-1);
    const noted = q("auth", ["Cookies", "JWT"], { note: { label: "Other" } });
    expect(rowForDigit(noted, 3)).toBe(2);
    expect(rowForDigit(noted, 4)).toBe(-1);
  });

  test("arriving at a question lands on its pick, else its first option", () => {
    expect(cursorFor(two[1], { selected: [] })).toBe(0);
    expect(cursorFor(two[1], { selected: ["mysql"] })).toBe(2);
    // a value the question no longer offers is no pick
    expect(cursorFor(two[1], { selected: ["gone"] })).toBe(0);
  });

  test("left and right stop at the ends instead of coming round", () => {
    expect(walk(0, -1, 3)).toBe(0);
    expect(walk(0, 1, 3)).toBe(1);
    expect(walk(2, 1, 3)).toBe(2);
    expect(walk(0, 1, 1)).toBe(0);
  });

  test("the next unanswered question is found in order, wrapping round to one skipped over", () => {
    let d = emptyDraft(three);
    expect(nextUnanswered(three, d, 0)).toBe(1);
    // the third was answered first (walked to with the arrows), so after the first comes the second
    d = choose(d, 2, "redis", false);
    expect(nextUnanswered(three, d, 0)).toBe(1);
    // and after the second, the wrap finds the first still open
    d = choose(d, 1, "sqlite", false);
    expect(nextUnanswered(three, d, 1)).toBe(0);
    d = choose(d, 0, "jwt", false);
    expect(nextUnanswered(three, d, 0)).toBe(-1);
  });

  test("a single-select pick moves on to what is left, and the last one sends", () => {
    let d = choose(emptyDraft(two), 0, "jwt", false);
    expect(advance(two, d, 0)).toEqual({ current: 1, cursor: 0, send: false });
    d = choose(d, 1, "mysql", false);
    // nothing left: stay on the question just answered, cursor on its pick, and go
    expect(advance(two, d, 1)).toEqual({ current: 1, cursor: 2, send: true });
    // one question is the common shape, and it answers as one keystroke
    expect(advance(one, choose(emptyDraft(one), 0, "cookies", false), 0)).toEqual({
      current: 0,
      cursor: 0,
      send: true,
    });
  });
});

describe("recommended", () => {
  test("the agent's suffix comes off the label and becomes a badge", () => {
    expect(recommended("Yes, fast-forward only (Recommended)")).toBe(true);
    expect(stripRecommended("Yes, fast-forward only (Recommended)")).toBe("Yes, fast-forward only");
    expect(recommended("Yes, fast-forward only (recommended) ")).toBe(true);
    expect(recommended("No, local main only")).toBe(false);
    expect(stripRecommended("No, local main only")).toBe("No, local main only");
    // only a suffix: a label that says the word mid-sentence keeps it
    expect(recommended("The (Recommended) option is gone")).toBe(false);
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
