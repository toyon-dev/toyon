import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@toyon/shared";
import { carried, inText, newsToSend, sentence, starts, untold } from "./news.ts";

const log = (...events: AgentEvent[]) => events.map((event, seq) => ({ seq, event }));

const said = (text: string): AgentEvent => ({ type: "user-message", text, ts: 0 });
const list = (held?: true): AgentEvent => ({
  type: "handoff-proposed",
  id: "h1",
  pieces: [
    { id: "p1", title: "Fix it", plan: "do it", attachments: [], fate: "here" },
    { id: "p2", title: "Docs", plan: "write them", attachments: [], fate: "worktree" },
  ],
  mode: held ? "plan" : "auto",
  ...(held ? { held } : {}),
  ts: 1,
});
const go = (note?: string): AgentEvent => ({ type: "handoff-go", id: "h1", ...(note ? { note } : {}), ts: 2 });
const kept: AgentEvent = {
  type: "handoff",
  id: "h1",
  outcomes: [
    { pieceId: "p1", fate: "here" },
    { pieceId: "p2", fate: "worktree", worktreeId: "b", title: "Docs" },
  ],
  ts: 3,
};
const away: AgentEvent = {
  type: "handoff",
  id: "h1",
  outcomes: [
    { pieceId: "p1", fate: "skip" },
    { pieceId: "p2", fate: "worktree", worktreeId: "b", title: "Docs" },
  ],
  ts: 3,
};
const waits: AgentEvent = {
  type: "handoff",
  id: "h1",
  outcomes: [
    { pieceId: "p1", fate: "here", after: "Docs" },
    { pieceId: "p2", fate: "worktree", worktreeId: "b", title: "Docs" },
  ],
  ts: 3,
};
const notNow = (more: Partial<Extract<AgentEvent, { type: "handoff-declined" }>> = {}): AgentEvent => ({
  type: "handoff-declined",
  id: "h1",
  ...more,
  ts: 3,
});
const asked: AgentEvent = { type: "fix-asked", text: "fix", kind: "check", why: "the check failed", ts: 6 };
const landed = (title: string, why: Partial<Extract<AgentEvent, { type: "piece-landed" }>> = {}): AgentEvent => ({
  type: "piece-landed",
  worktreeId: title.toLowerCase(),
  repoName: "toyon",
  title,
  branch: `toyon/${title.toLowerCase()}`,
  same: true,
  ...why,
  ts: 5,
});

describe("untold and carried", () => {
  test("news is untold until a message follows it, and that message is the one to carry it", () => {
    const entries = log(said("one"), landed("A"), said("two"), landed("B"));
    expect(untold(entries).map((n) => n.kind === "landed" && n.event.title)).toEqual(["B"]);
    expect(carried(entries, 2).map((n) => n.kind === "landed" && n.event.title)).toEqual(["A"]);
    // Toyon's own message and one handed on from another chat are messages too
    expect(untold(log(landed("A"), asked))).toEqual([]);
    expect(carried(log(landed("A"), asked), 1)).toHaveLength(1);
    expect(untold(log(landed("A")))).toHaveLength(1);
    // a record the transcript does not hold carries nothing
    expect(carried(log(landed("A")), 7)).toEqual([]);
  });

  test("a message carries what came before its own record, whichever order the two went out in", () => {
    // Toyon's message was recorded as it was queued, behind a message of the person's that is
    // recorded only as its turn starts: the person's goes out first and is written last
    const entries = log(said("one"), landed("A", { wake: true }), asked, said("two"));
    expect(carried(entries, 3)).toEqual([]);
    expect(carried(entries, 2).map((n) => n.kind === "landed" && n.event.title)).toEqual(["A"]);
    expect(untold(entries)).toEqual([]);
  });

  test("a reader with its own mark of the last message reads from there", () => {
    const entries = log(landed("A"), landed("B"));
    expect(untold(entries, 1).map((n) => n.kind === "landed" && n.event.title)).toEqual(["B"]);
  });

  test("an answer names its list, the note on its go, and whether a plan card gave it", () => {
    expect(untold(log(list(), go("carefully"), kept))[0]).toMatchObject({
      kind: "answered",
      note: "carefully",
      withPlan: false,
    });
    expect(untold(log(list(true), go(), kept))[0]).toMatchObject({ withPlan: true });
    // a held list shown as Toyon's own card was answered there
    expect(untold(log(list(true), { type: "handoff-shown", id: "h1", ts: 2 }, notNow()))[0]).toMatchObject({
      kind: "declined",
      withPlan: false,
    });
    // an answer to a list the transcript does not hold is nobody's news
    expect(untold(log(go(), kept))).toEqual([]);
  });
});

describe("what starts the agent and what rides", () => {
  const one = (...events: AgentEvent[]) => untold(log(...events)).at(-1)!;

  test("a landing starts the agent when the service marked it, and is said both ways", () => {
    expect(starts(one(landed("A", { wake: true })))).toBe(true);
    expect(starts(one(landed("A")))).toBe(false);
    expect(inText(one(landed("A", { wake: true })))).toBe(false);
    expect(sentence(one(landed("A")), { chatOf: (id) => `/chats/${id}` })).toContain("Its chat is at /chats/a");
  });

  test("a go on Toyon's own card starts the agent only on a piece kept here with nothing to wait for", () => {
    expect(starts(one(list(), go(), kept))).toBe(true);
    expect(inText(one(list(), go(), kept))).toBe(true);
    expect(starts(one(list(), go(), away))).toBe(false);
    expect(starts(one(list(), go(), waits))).toBe(false);
    expect(sentence(one(list(), go("v2"), away))).toContain(
      '"Fix it" was skipped by the person. Nothing on the list is yours here.',
    );
    expect(sentence(one(list(), go("v2"), away))).toEndWith("The person added: v2");
  });

  test("a plan's yes starts nothing and says nothing, but for a piece that could not start", () => {
    expect(starts(one(list(true), go(), kept))).toBe(false);
    expect(sentence(one(list(true), go(), kept))).toBeUndefined();
    const broke: AgentEvent = {
      type: "handoff",
      id: "h1",
      outcomes: [
        { pieceId: "p1", fate: "here" },
        { pieceId: "p2", fate: "worktree", error: "no port" },
      ],
      ts: 3,
    };
    expect(sentence(one(list(true), go(), broke))).toBe(
      'Toyon could not finish acting on the list you handed over ("Docs"): no port. A piece may not have started; say so, and hand it over again if the split still fits.',
    );
  });

  test("not now starts the agent on the words typed with it; bare, failed or Toyon's own closing do not", () => {
    expect(starts(one(list(), notNow({ note: "smaller" })))).toBe(true);
    expect(sentence(one(list(), notNow({ note: "smaller" })))).toContain("They added: smaller");
    expect(starts(one(list(), notNow()))).toBe(false);
    expect(sentence(one(list(), notNow()))).toContain("answered the handoff card with not now");
    const failed = notNow({ outcome: "failed", reason: "the project is no longer open" });
    expect(starts(one(list(), go(), failed))).toBe(false);
    expect(sentence(one(list(), go(), failed))).toContain("could not finish acting on the list");
    const closed = notNow({ reason: "handed over again" });
    expect(starts(one(list(), closed))).toBe(false);
    expect(sentence(one(list(), closed))).toBeUndefined();
    // a plan sent back took the list with it, which the agent was told with the no
    expect(starts(one(list(true), notNow()))).toBe(false);
    expect(sentence(one(list(true), notNow()))).toBeUndefined();
  });

  test("an agent without Toyon's tools hears of landings and of no card", () => {
    expect(sentence(one(list(), go(), away), { cards: false })).toBeUndefined();
    expect(sentence(one(list(), notNow()), { cards: false })).toBeUndefined();
    expect(sentence(one(landed("A")), { cards: false })).toContain('"A"');
  });
});

describe("newsToSend", () => {
  test("nothing untold that starts the agent is no message", () => {
    expect(newsToSend(log(said("one"), landed("A"), list(), go(), away))).toBeNull();
    // told already: a message went after it
    expect(newsToSend(log(landed("A", { wake: true }), said("two")))).toBeNull();
  });

  test("landings make one message that names the pieces to do, whoever each was to this worktree", () => {
    const msg = newsToSend(
      log(
        landed("A", { awaited: true, pieces: ["Mine"], wake: true }),
        landed("B", { wake: true }),
        landed("C", { sent: true, wake: true, same: undefined, repoName: "other" }),
        landed("D", { again: true }),
      ),
    )!;
    expect(msg.text).toContain('The branch your own piece "Mine" waited for, "A" (toyon/a), has landed');
    expect(msg.text).toContain('The work this worktree handed off, "B" (toyon/b), has landed');
    expect(msg.text).toContain(
      'The worktree this one sent a piece to, "C" (toyon/c), has landed on main in the project other',
    );
    expect(msg.text).toContain('Do "Mine" here now, and only that.');
    expect(msg.text).not.toContain('"D"');
    expect(msg.why).toBe('"A", "B", "C" landed, so the agent starts the piece that waited');
    // nothing here waited: the agent takes up what it handed off
    expect(newsToSend(log(landed("B", { wake: true })))!.why).toBe(
      '"B" landed, so the agent takes up what it handed off',
    );
  });

  test("a worktree whose own work is done is started by its card, not by a landing", () => {
    const entries = log(landed("A", { wake: true }), list(), go(), kept);
    expect(newsToSend(log(landed("A", { wake: true })), { rest: true })).toBeNull();
    const msg = newsToSend(entries, { rest: true })!;
    expect(msg.text).toContain('Do "Fix it" here, and only that.');
    expect(msg.text).not.toContain("has landed");
    expect(msg.why).toBe("the piece kept here, so the agent starts on it");
  });

  test("an answer and a landing untold together are one message, each in its words", () => {
    const msg = newsToSend(log(list(), notNow({ note: "smaller" }), landed("A", { wake: true })))!;
    expect(msg.text.split("\n\n")).toHaveLength(3);
    expect(msg.text).toContain("They added: smaller");
    expect(msg.text).toContain('"A" (toyon/a), has landed');
    expect(msg.why).toBe(
      'the list was sent back with a note, so the agent reads it before going on; "A" landed, so the agent takes up what it handed off',
    );
  });
});
