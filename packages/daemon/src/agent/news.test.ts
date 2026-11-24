import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@toyon/shared";
import { carried, isNews, newsToSend, sentence, starts, untold } from "./news.ts";
import { formatOutput } from "./output.ts";

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

/** a command's two rows, as the daemon leaves them when it fails */
const row = (toolId: string, command: string, text: string): AgentEvent[] => [
  { type: "tool-start", toolId, name: "shell", input: { command } },
  { type: "tool-end", toolId, output: formatOutput(text, 1, false), isError: true },
];
const checkFailed = (n: number): AgentEvent[] => [
  ...row(`check-${n}`, "bun run check", `${n} errors\n`),
  { type: "failure", kind: "check", toolId: `check-${n}`, ts: 7 },
];
const hookRefused: AgentEvent[] = [
  ...row("shell-1", "git commit -m x", "lint: 1 error\n"),
  { type: "failure", kind: "hook", hook: "pre-commit", toolId: "shell-1", ts: 7 },
];
const conflict = (more: { toolId?: string; carried?: string[] } = {}): AgentEvent => ({
  type: "failure",
  kind: "conflict",
  base: "main",
  how: "rebase",
  ...more,
  ts: 7,
});
const gone = (title: string, why: Partial<Extract<AgentEvent, { type: "piece-gone" }>> = {}): AgentEvent => ({
  type: "piece-gone",
  worktreeId: title.toLowerCase(),
  title,
  archived: true,
  ...why,
  ts: 8,
});
/** Toyon's own message for the news before it, as the session records it as it goes */
const told = (toolId?: string): AgentEvent => ({
  type: "fix-asked",
  text: "fix",
  kind: "news",
  why: "to fix the failed check",
  ...(toolId ? { toolId } : {}),
  ts: 9,
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

  test("a message carries what came before its own record, whichever is the newest on the transcript", () => {
    // a message is recorded ahead of the request that carries it, and another may be recorded
    // meanwhile: each still carries what came before its own record, not before the newest
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
    // the text names the pieces to do; the sentence what landed and where that chat is
    expect(sentence(one(landed("A", { wake: true })), { said: true })).toContain('"A"');
    expect(sentence(one(landed("A")), { chatOf: (id) => `/chats/${id}` })).toContain("Its chat is at /chats/a");
  });

  test("a go on Toyon's own card starts the agent only on a piece kept here with nothing to wait for", () => {
    expect(starts(one(list(), go(), kept))).toBe(true);
    // Toyon's message for it says it in its text, so nothing rides behind
    expect(sentence(one(list(), go(), kept), { said: true })).toBeUndefined();
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
    // a plan sent back took the list with it: the no ended the agent's turn, so the word starts
    // none and is said behind the person's next message
    expect(starts(one(list(true), notNow()))).toBe(false);
    expect(sentence(one(list(true), notNow()))).toContain("went back with the plan");
    // a list Toyon read off the plan was never the agent's to hand over again
    const read = { ...list(true), by: "toyon" } as AgentEvent;
    expect(sentence(one(read, notNow()))).toBeUndefined();
    // an agent without Toyon's tools handed nothing over
    expect(sentence(one(list(true), notNow()), { cards: false })).toBeUndefined();
  });

  test("a failure that is the agent's to fix starts it, with what was printed behind the message", () => {
    const hook = one(...hookRefused);
    expect(hook).toMatchObject({
      kind: "failed",
      failure: { kind: "hook", hook: "pre-commit", command: "git commit -m x", text: "lint: 1 error" },
    });
    expect(starts(hook)).toBe(true);
    // the same paragraph whether Toyon's own message asks for the fix or a message of the
    // person's goes first: the text asks, the paragraph shows
    const shown = "What Toyon ran, and what it printed:\n$ git commit -m x\nlint: 1 error";
    expect(sentence(hook, { said: true })).toBe(shown);
    expect(sentence(hook)).toBe(shown);
    // an agent without Toyon's tools still fixes its own check
    expect(sentence(one(...checkFailed(1)), { cards: false })).toContain("$ bun run check\n1 errors");
    // a check or a hook whose row is gone leaves nothing to show, and is no news
    expect(untold(log({ type: "failure", kind: "check", toolId: "nope", ts: 7 }))).toEqual([]);
  });

  test("a conflict is news with or without a step on the chat, and carries its ask when it rides", () => {
    const bare = one(conflict({ carried: ["a.ts"] }));
    expect(starts(bare)).toBe(true);
    // Toyon's own message says the ask in its text, and no step ran to show
    expect(sentence(bare, { said: true })).toBeUndefined();
    // riding a message of the person's, the ask is the only word there is of it
    expect(sentence(bare)).toBe(
      "Rebase this branch onto main and resolve the conflicts, keeping any uncommitted changes, then verify the app still works. The branch's own commits take main cleanly; the conflicts are in the uncommitted changes, in a.ts.",
    );
    const stepped = one(...row("shell-2", "git rebase main", "CONFLICT in a.ts\n"), conflict({ toolId: "shell-2" }));
    expect(sentence(stepped, { said: true })).toBe(
      "What Toyon ran, and what it printed:\n$ git rebase main\nCONFLICT in a.ts",
    );
    expect(sentence(stepped)).toStartWith("Rebase this branch onto main and resolve the conflicts");
    expect(sentence(stepped)).toEndWith("$ git rebase main\nCONFLICT in a.ts");
  });

  test("the check starts the agent once in a row: the turn sent to fix it ends in the same check", () => {
    // straight after Toyon's own message for a failed check
    expect(starts(one(...checkFailed(1), told("check-1"), ...checkFailed(2)))).toBe(false);
    // or after a press on the check's row
    expect(starts(one(asked, ...checkFailed(2)))).toBe(false);
    // it rides the next message instead, with what it printed
    const second = one(...checkFailed(1), told("check-1"), ...checkFailed(2));
    expect(sentence(second)).toContain("$ bun run check\n2 errors");
    // a message that is not about the check lets the next failure start it again
    expect(starts(one(...checkFailed(1), told("check-1"), ...checkFailed(2), said("try x"), ...checkFailed(3)))).toBe(
      true,
    );
    // so does Toyon's message for other news, unless a failed check rode behind it
    expect(starts(one(landed("A", { wake: true }), told(), ...checkFailed(1)))).toBe(true);
    expect(
      starts(one(...checkFailed(1), told(), ...checkFailed(2), landed("A", { wake: true }), told(), ...checkFailed(3))),
    ).toBe(false);
    // a hook or a conflict comes back only through another press, so neither is capped
    const again: AgentEvent[] = [
      ...row("shell-3", "git commit -m y", "no\n"),
      { type: "failure", kind: "hook", hook: "pre-commit", toolId: "shell-3", ts: 7 },
    ];
    expect(starts(one(...hookRefused, told("shell-1"), ...again))).toBe(true);
    expect(starts(one(conflict(), told(), conflict()))).toBe(true);
  });

  test("a worktree gone before it landed starts the agent only where a piece waited for it", () => {
    const waited = one(gone("First", { awaited: true, pieces: ["Mine"], wake: true }));
    expect(starts(waited)).toBe(true);
    expect(sentence(waited, { said: true })).toBeUndefined();
    expect(sentence(waited)).toBe(
      'The worktree your own piece "Mine" waited for, "First", was archived before it landed, so its work is not on main and the piece no longer waits.',
    );
    // found stale, with nobody there to see a turn begin: the word rides the next message
    expect(starts(one(gone("First", { awaited: true, pieces: ["Mine"] })))).toBe(false);
    // a worktree made from a piece, or one a piece was sent into, is only news
    expect(starts(one(gone("Docs")))).toBe(false);
    expect(sentence(one(gone("Docs")))).toContain('The worktree made from your piece, "Docs", was archived');
    expect(sentence(one(gone("Composer", { sent: true })))).toContain("and the piece with it, is not on main");
  });

  test("a queued piece dropped rides the next message and starts nothing", () => {
    const dropped: AgentEvent = {
      type: "piece-dropped",
      id: "h1",
      pieceId: "p2",
      reason: 'the worktree it waited for, "First", is gone',
      ts: 8,
    };
    expect(isNews(dropped)).toBe(true);
    expect(starts(one(list(), dropped))).toBe(false);
    expect(sentence(one(list(), dropped))).toBe(
      'Your queued piece "Docs" was dropped: the worktree it waited for, "First", is gone.',
    );
    // its list is off the transcript: still said, unnamed
    expect(sentence(one(dropped))).toStartWith("A piece you queued was dropped:");
    expect(newsToSend(log(list(), dropped))).toBeNull();
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
    // the row's sentence, after the worktrees it is from: what the agent does about each kind of
    // landing, each clause naming its own since they differ. With a piece to start, the work
    // handed off is only mentioned to it, so the row leaves it out
    expect(msg.why).toBe('to start "Mine", which waited for "A", and to check "C" against the piece written here');
    // every landing that starts it is who the message is from; one in another project says where
    expect(msg.from).toEqual([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C", project: "other" },
    ]);
  });

  test("the reason says what the agent does about the landing, by what the landing is to it", () => {
    const why = (...events: AgentEvent[]) => newsToSend(log(...events))!.why;
    // nothing here waited for work handed off: the agent checks the landing against the piece
    // this chat wrote. The row names the landed worktrees first, so a clause about all of them
    // says "it" or "them"
    expect(why(landed("B", { wake: true }))).toBe("to check it against the piece written here");
    // a piece sent into an open worktree is the same check
    expect(why(landed("C", { sent: true, wake: true }))).toBe("to check it against the piece written here");
    expect(why(landed("B", { wake: true }), landed("C", { sent: true, wake: true }))).toBe(
      "to check them against the pieces written here",
    );
    // a wait recorded without its pieces
    expect(why(landed("A", { awaited: true, wake: true }))).toBe("to start the piece that waited for it");
    expect(
      why(
        landed("A", { awaited: true, pieces: ["One", "Two"], wake: true }),
        landed("E", { awaited: true, pieces: ["Two", "Three"], wake: true }),
      ),
    ).toBe('to start "One", "Two" and "Three", which waited for them');
  });

  test("a worktree whose own work is done is started by its card, not by a landing", () => {
    const entries = log(landed("A", { wake: true }), list(), go(), kept);
    expect(newsToSend(log(landed("A", { wake: true })), { rest: true })).toBeNull();
    const msg = newsToSend(entries, { rest: true })!;
    expect(msg.text).toContain('Do "Fix it" here, and only that.');
    expect(msg.text).not.toContain("has landed");
    expect(msg.why).toBe("to start the piece kept here");
    // an answer on Toyon's own card has no other chat behind it
    expect(msg.from).toBeUndefined();
  });

  test("its own landing starts a worktree at rest on the part that waited; any other landing still does not", () => {
    const own = landed("Rail", { awaited: true, own: true, pieces: ["Part 2"], wake: true });
    const msg = newsToSend(log(own), { rest: true })!;
    expect(msg.text).toBe(
      'This worktree\'s own work has landed on this project\'s main, which your own piece "Part 2" waited for; its branch restarted from main, so the piece starts on a fresh branch. Do "Part 2" here now, and only that.',
    );
    // the row names no sender: a chip for this chat would name the row the reader is in
    expect(msg.why).toBe('to start "Part 2", which waited for this worktree to land');
    expect(msg.from).toBeUndefined();
    // a sibling's landing untold beside it is only news to a worktree at rest: it rides behind
    const both = newsToSend(log(landed("A", { awaited: true, pieces: ["Mine"], wake: true }), own), { rest: true })!;
    expect(both.text).not.toContain('"A"');
    expect(both.text).toContain('Do "Part 2" here now, and only that.');
    expect(newsToSend(log(landed("A", { awaited: true, pieces: ["Mine"], wake: true })), { rest: true })).toBeNull();
    // with work in its tree again both start it, in one message: what the sibling landed is the
    // only work to read on main
    const atWork = newsToSend(log(landed("A", { awaited: true, pieces: ["Mine"], wake: true }), own))!;
    expect(atWork.text).toContain('Do "Mine", "Part 2" here now, and only those.');
    expect(atWork.text).toEndWith(
      'What "A" landed is readable on main now, and Toyon rebases onto main when this lands.',
    );
    expect(atWork.why).toBe(
      'to start "Mine", which waited for it, and to start "Part 2", which waited for this worktree to land',
    );
    expect(atWork.from).toEqual([{ id: "a", title: "A" }]);
    // carried by a message of the person's instead, it says the same without naming a chat to read
    expect(sentence(untold(log(own))[0]!, { chatOf: (id) => `/chats/${id}` })).toBe(
      "This worktree's own work has landed on this project's main, and its branch restarted from main. Your own piece \"Part 2\" waited for that landing and can go ahead now, on the fresh branch.",
    );
  });

  test("a go that keeps a part here until this worktree lands says Toyon starts it, and starts only what is ready", () => {
    const parts: AgentEvent = {
      type: "handoff",
      id: "h1",
      outcomes: [
        { pieceId: "p1", fate: "here" },
        { pieceId: "p2", fate: "here", after: "toyon/rail", own: true },
      ],
      ts: 3,
    };
    const msg = newsToSend(log(list(), go(), parts))!;
    expect(msg.text).toBe(
      'The person answered the handoff card, and Toyon acted on the pieces you handed over. Do "Fix it", "Docs" (once this worktree lands) here, and only that. A piece that waits for this worktree is not yours to start: the person lands what is here first, and Toyon starts you on it then, one piece per landing in list order.',
    );
    // a list whose only piece waits for the landing starts no turn: the landing does
    const later: AgentEvent = { ...parts, outcomes: [parts.outcomes[1]!] };
    expect(newsToSend(log(list(), go(), later))).toBeNull();
  });

  test("an answer and a landing untold together are one message, each in its words", () => {
    const msg = newsToSend(log(list(), notNow({ note: "smaller" }), landed("A", { wake: true })))!;
    expect(msg.text.split("\n\n")).toHaveLength(3);
    expect(msg.text).toContain("They added: smaller");
    expect(msg.text).toContain('"A" (toyon/a), has landed');
    // the landing's clause first, since the row has just named the worktree it speaks of
    expect(msg.why).toBe("to check it against the piece written here, and to read the note sent back with the list");
    expect(msg.from).toEqual([{ id: "a", title: "A" }]);
  });

  test("a landing checked against the piece names the file the piece sits on", () => {
    const msg = newsToSend(log(landed("B", { wake: true, brief: ".toyon/plans/2.md" })))!;
    expect(msg.text).toContain("the piece this chat wrote for it, which is in .toyon/plans/2.md, and say what is");
  });

  test("a failure makes Toyon's own message: what to fix, the reason for the row, and the row it is about", () => {
    const msg = newsToSend(log(said("one"), ...checkFailed(1)))!;
    expect(msg.text).toBe(
      "The repo's check, `bun run check`, failed, and what it printed is attached below. Fix what it reports, inside this worktree. Do not weaken the check or its configuration to get past it. Toyon runs it again when your turn ends.",
    );
    expect(msg.why).toBe("to fix the failed check");
    expect(msg.toolId).toBe("check-1");
    // no other chat is behind a failure
    expect(msg.from).toBeUndefined();
    // the text says the failure, so only what was printed rides behind it
    expect(msg.said).toHaveLength(1);
    expect(msg.said[0]).toMatchObject({ type: "failure", toolId: "check-1" });
    // a conflict with no step names no row
    const clash = newsToSend(log(conflict()))!;
    expect(clash.text).toStartWith("Rebase this branch onto main and resolve the conflicts");
    expect(clash.why).toBe("to rebase onto main and resolve the conflicts");
    expect(clash.toolId).toBeUndefined();
    // the check failed again straight after: no second message, whatever else is untold
    expect(newsToSend(log(...checkFailed(1), told("check-1"), ...checkFailed(2)))).toBeNull();
    // a worktree whose own work is done can still have a check to fix
    expect(newsToSend(log(...hookRefused), { rest: true })?.why).toBe("to fix what the pre-commit hook refused");
  });

  test("a worktree gone that a piece waited for makes a message; at rest it is only news", () => {
    const entries = log(gone("First", { awaited: true, pieces: ["Mine"], wake: true }));
    const msg = newsToSend(entries)!;
    expect(msg.text).toBe(
      'The worktree your own piece "Mine" waited for, "First", was archived before it landed, so its work is not on main and the piece no longer waits. If the piece can be done without that work, do it here now, and only that; if it cannot, say what is missing and change nothing.',
    );
    expect(msg.why).toBe('to see whether "Mine" can go ahead without it');
    // it did not land, so no chat is reporting back
    expect(msg.from).toBeUndefined();
    expect(newsToSend(entries, { rest: true })).toBeNull();
    // a wait recorded without its pieces, and two worktrees gone at once
    expect(newsToSend(log(gone("First", { awaited: true, wake: true })))?.why).toBe(
      "to see whether the piece that waited can go ahead without it",
    );
    expect(
      newsToSend(
        log(
          gone("First", { awaited: true, pieces: ["One"], wake: true }),
          gone("Second", { awaited: true, pieces: ["Two"], wake: true }),
        ),
      )?.why,
    ).toBe('to see whether "One" and "Two" can go ahead without them');
  });

  test("a failure and a landing untold together are one message", () => {
    const msg = newsToSend(log(...hookRefused, landed("A", { awaited: true, pieces: ["Mine"], wake: true })))!;
    expect(msg.text).toContain("The pre-commit hook refused that");
    expect(msg.text).toContain('Do "Mine" here now, and only that.');
    expect(msg.why).toBe('to start "Mine", which waited for it, and to fix what the pre-commit hook refused');
    expect(msg.toolId).toBe("shell-1");
    expect(msg.said).toHaveLength(2);
  });
});
