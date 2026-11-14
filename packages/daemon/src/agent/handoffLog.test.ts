import { describe, expect, test } from "bun:test";
import type { AgentEvent, Piece } from "@toyon/shared";
import {
  answeredWithPlan,
  effectiveFate,
  heldUnshown,
  listFile,
  openHandoff,
  openPlanCard,
  ownCards,
  pressedOnSentBack,
  proposedList,
} from "./handoffLog.ts";

const log = (...events: AgentEvent[]) => events.map((event, seq) => ({ seq, event }));

const pieces: Piece[] = [
  { id: "p1", title: "Rail", plan: "Fix the rail.", attachments: [], fate: "worktree" },
  { id: "p2", title: "Notes", plan: "Add notes.", attachments: [], fate: "here" },
];
const list = (id: string, more: Partial<Extract<AgentEvent, { type: "handoff-proposed" }>> = {}): AgentEvent => ({
  type: "handoff-proposed",
  id,
  pieces,
  mode: more.held ? "plan" : "auto",
  ...more,
  ts: 1,
});
const card = (id: string, more: Partial<Extract<AgentEvent, { type: "agent-permission" }>> = {}): AgentEvent => ({
  type: "agent-permission",
  id,
  title: "Approve Plan",
  plan: ".toyon/plans/1.md",
  choices: [],
  ...more,
  ts: 2,
});
const closed = (id: string, outcome: "answered" | "cancelled" = "answered"): AgentEvent => ({
  type: "agent-ask-end",
  id,
  outcome,
  ts: 3,
});
const ids = (lists: ReadonlyArray<{ id: string }>) => lists.map((l) => l.id);

describe("where a list stands", () => {
  test("a list is open from its proposal until a go, its outcomes or a decline", () => {
    expect(ids(openHandoff(log(list("l1"))))).toEqual(["l1"]);
    expect(openHandoff(log(list("l1"), { type: "handoff-go", id: "l1", ts: 2 }))).toEqual([]);
    expect(openHandoff(log(list("l1"), { type: "handoff", id: "l1", outcomes: [], ts: 2 }))).toEqual([]);
    expect(openHandoff(log(list("l1"), { type: "handoff-declined", id: "l1", ts: 2 }))).toEqual([]);
    // newest last, and a closer names its own list alone
    const two = log(list("l1"), list("l2"), { type: "handoff-declined", id: "l1", ts: 3 });
    expect(ids(openHandoff(two))).toEqual(["l2"]);
    expect(proposedList(two, "l1")?.id).toBe("l1");
    expect(proposedList(two, "l9")).toBeUndefined();
  });

  test("a list proposed in plan mode is held for a plan card until it is shown as Toyon's own", () => {
    const held = log(list("l1", { held: true }));
    expect(heldUnshown(held)?.id).toBe("l1");
    expect(ownCards(held)).toEqual([]);
    const shown = log(list("l1", { held: true }), { type: "handoff-shown", id: "l1", ts: 2 });
    expect(heldUnshown(shown)).toBeNull();
    expect(ids(ownCards(shown))).toEqual(["l1"]);
    // one proposed outside plan mode is Toyon's card at once, and neither is one once closed
    expect(ids(ownCards(log(list("l2"))))).toEqual(["l2"]);
    expect(heldUnshown(log(list("l2")))).toBeNull();
    expect(ownCards(log(list("l2"), { type: "handoff-go", id: "l2", ts: 2 }))).toEqual([]);
    expect(heldUnshown(log(list("l1", { held: true }), { type: "handoff-declined", id: "l1", ts: 2 }))).toBeNull();
  });

  test("a held list stays held through a plan card that came and went, whoever closed it", () => {
    // carried by the card, the card cancelled: still the agent's word, for the next plan card
    const cancelled = log(list("l1", { held: true }), card("k1", { handoff: "l1" }), closed("k1", "cancelled"));
    expect(heldUnshown(cancelled)?.id).toBe("l1");
    // handed over while the card was up: held all the same, and the card's to answer
    const late = log(card("k1"), list("l1", { held: true }));
    expect(heldUnshown(late)?.id).toBe("l1");
    expect(openPlanCard(late)?.id).toBe("k1");
  });

  test("the plan card open is the last one with a plan and no end", () => {
    expect(openPlanCard(log(card("k1")))?.id).toBe("k1");
    expect(openPlanCard(log(card("k1"), closed("k1")))).toBeNull();
    // a permission card with no plan is an edit's or a command's
    expect(openPlanCard(log({ type: "agent-permission", id: "k2", title: "Edit", choices: [], ts: 1 }))).toBeNull();
  });

  test("a list was the plan card's to answer when it was held and never shown", () => {
    const held = list("l1", { held: true }) as Extract<AgentEvent, { type: "handoff-proposed" }>;
    expect(answeredWithPlan(log(held), held)).toBe(true);
    expect(answeredWithPlan(log(held, { type: "handoff-shown", id: "l1", ts: 2 }), held)).toBe(false);
    const own = list("l2") as Extract<AgentEvent, { type: "handoff-proposed" }>;
    expect(answeredWithPlan(log(own), own)).toBe(false);
  });
});

describe("listFile", () => {
  test("Toyon's own card names the page it wrote; a held list names the agent's plan until it is shown", () => {
    const own = list("l1", { plan: ".toyon/plans/1.md" });
    expect(listFile(log(own), "l1")).toBe(".toyon/plans/1.md");
    // read off the plan in plan mode: the file is the plan, which holds no plan of its own
    const read = list("l2", { held: true, plan: ".toyon/plans/2.md", by: "toyon" });
    expect(listFile(log(own, read), "l2")).toBe(".toyon/plans/2.md");
    // shown as Toyon's own card after its turn: the page written then is the file from here
    const shown: AgentEvent = { type: "handoff-shown", id: "l2", plan: ".toyon/plans/3.md", ts: 3 };
    expect(listFile(log(own, read, shown), "l2")).toBe(".toyon/plans/3.md");
    // the agent's own held list names no file until it is shown
    expect(listFile(log(list("l3", { held: true })), "l3")).toBeUndefined();
  });

  test("a held list answered with a plan card names the card's plan, since nothing on the list does", () => {
    const entries = log(list("l1", { held: true }), card("k1", { plan: ".toyon/plans/3.md", handoff: "l1" }));
    expect(listFile(entries, "l1")).toBe(".toyon/plans/3.md");
    expect(listFile(entries, "l2")).toBeUndefined();
  });
});

describe("fates", () => {
  const fate = (id: string, pieceId: string, to: "here" | "worktree" | "skip"): AgentEvent => ({
    type: "handoff-fate",
    id,
    pieceId,
    fate: to,
    ts: 2,
  });

  test("the person's last press on a piece stands over what the agent proposed", () => {
    const proposed = list("l1") as Extract<AgentEvent, { type: "handoff-proposed" }>;
    expect(effectiveFate(log(proposed), proposed, pieces[0]!)).toBe("worktree");
    const pressed = log(proposed, fate("l1", "p1", "skip"), fate("l1", "p1", "here"), fate("l9", "p1", "skip"));
    expect(effectiveFate(pressed, proposed, pieces[0]!)).toBe("here");
    expect(effectiveFate(pressed, proposed, pieces[1]!)).toBe("here");
  });

  test("presses on a held list the plan's no took with it carry to the next list by title", () => {
    const back = log(list("l1", { held: true }), fate("l1", "p1", "skip"), {
      type: "handoff-declined",
      id: "l1",
      ts: 3,
    });
    expect([...pressedOnSentBack(back)]).toEqual([["rail", "skip"]]);
    // a list answered as Toyon's own card was an answer: nothing carries
    const answered = log(
      list("l1", { held: true }),
      { type: "handoff-shown", id: "l1", ts: 2 },
      fate("l1", "p1", "skip"),
      { type: "handoff-declined", id: "l1", ts: 3 },
    );
    expect(pressedOnSentBack(answered).size).toBe(0);
    // nor from a go that broke off, or a list still open
    const failed = log(list("l1", { held: true }), fate("l1", "p1", "skip"), {
      type: "handoff-declined",
      id: "l1",
      outcome: "failed",
      reason: "no port",
      ts: 3,
    });
    expect(pressedOnSentBack(failed).size).toBe(0);
    expect(pressedOnSentBack(log(list("l1", { held: true }), fate("l1", "p1", "skip"))).size).toBe(0);
  });
});
