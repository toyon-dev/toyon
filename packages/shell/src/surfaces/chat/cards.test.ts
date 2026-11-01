import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../../state/store.ts";
import { cardDropBox, cardLine, openCard } from "./cards.ts";
import type { HandoffItem } from "./handoff.ts";

const pieces = (over: Partial<HandoffItem> = {}): HandoffItem => ({
  kind: "handoff",
  id: "l1",
  pieces: [{ id: "p1", title: "Rail", plan: "Fix the rail.", attachments: [], fate: "worktree" }],
  fates: { p1: "worktree" },
  mode: "auto",
  state: "proposed",
  outcomes: [],
  later: [],
  ts: 1,
  ...over,
});

const ask = (id: string, outcome?: "answered"): ChatItem => ({
  kind: "ask",
  id,
  ask: { kind: "question", message: "Which?", questions: [] },
  ...(outcome ? { outcome } : {}),
});

describe("openCard", () => {
  test("the newest open ask or proposed list holds the box; closed and held ones do not", () => {
    expect(openCard([ask("k1"), pieces()])?.id).toBe("l1");
    expect(openCard([pieces(), ask("k1")])?.id).toBe("k1");
    expect(openCard([pieces({ state: "done" }), ask("k1", "answered")])).toBeNull();
    expect(openCard([pieces({ state: "held", held: true }), ask("k1")])?.id).toBe("k1");
    expect(openCard([])).toBeNull();
  });
});

describe("cardDropBox", () => {
  test("a question card with the box takes the drop; set aside, closed, or another kind, the composer does", () => {
    expect(cardDropBox({ chat: [ask("k1")], cardParked: undefined })).toBe("card:k1");
    expect(cardDropBox({ chat: [ask("k1")], cardParked: "k1" })).toBeNull();
    expect(cardDropBox({ chat: [ask("k1", "answered")], cardParked: undefined })).toBeNull();
    expect(cardDropBox({ chat: [ask("k1"), pieces()], cardParked: undefined })).toBeNull();
    expect(cardDropBox(undefined)).toBeNull();
  });
});

describe("cardLine", () => {
  test("a list's line is the question its card asks; an ask keeps its own", () => {
    expect(cardLine(pieces())).toBe("Start a worktree for Rail?");
    expect(cardLine(ask("k1") as Extract<ChatItem, { kind: "ask" }>)).toBe("Which?");
  });
});
