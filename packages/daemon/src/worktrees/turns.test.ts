import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentStatus, LastTurn, WorktreeInfo } from "@toyon/shared";
import { Hub } from "../core/hub.ts";
import { ensureDirs, makePaths } from "../core/paths.ts";
import { StateStore } from "../core/state.ts";
import { isUnseen, TurnService, type TurnServiceDeps } from "./turns.ts";

// Hub-driven: statuses go in the way an agent session reports them, and the transcript is a list
// the test writes, so what is stamped is read off exactly what a turn would have left behind.

const home = mkdtempSync(join(tmpdir(), "toyon-turns-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const record = (id: string, extra: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  id,
  repoId: "r1",
  path: `/tmp/${id}`,
  branch: id,
  kind: "worktree",
  proxyPort: 1,
  title: id,
  createdAt: 0,
  ...extra,
});

function build(opts: Pick<TurnServiceDeps, "summarize" | "delayMs">, rows: WorktreeInfo[]) {
  const paths = makePaths(mkdtempSync(join(home, "w-")));
  ensureDirs(paths);
  const state = new StateStore(paths, { repos: [], worktrees: rows, sessions: {} });
  const hub = new Hub();
  const logs = new Map<string, AgentEvent[]>();
  const turns = new TurnService({
    state,
    hub,
    transcript: (id) => (logs.get(id) ?? []).map((event, seq) => ({ seq, event })),
    ...opts,
  });
  const settled: Array<[string, LastTurn]> = [];
  hub.on("turnSettled", (id, turn) => settled.push([id, turn]));
  return {
    state,
    turns,
    settled,
    wt: (id: string) => state.worktree(id)!,
    say: (id: string, ...events: AgentEvent[]) => logs.set(id, [...(logs.get(id) ?? []), ...events]),
    status: (id: string, ...statuses: AgentStatus[]) => {
      for (const s of statuses) hub.emit("agentStatus", id, s);
    },
  };
}
const world = (...rows: WorktreeInfo[]) => build({}, rows);

const user = (text: string, ts: number): AgentEvent => ({ type: "user-message", text, ts });
const start = (ts: number): AgentEvent => ({ type: "turn-start", ts });
const end = (ts: number, stopReason = "end_turn"): AgentEvent => ({ type: "turn-end", stopReason, ts });
const edit = (toolId: string): AgentEvent => ({ type: "tool-start", toolId, name: "Edit", input: {}, kind: "edit" });
const auth: AgentEvent = { type: "agent-auth-required", agent: "claude", agentName: "Claude", methods: [], ts: 12 };

describe("TurnService", () => {
  test("a finished turn is stamped done with what it did, rings until seen, and says so on the hub", () => {
    const w = world(record("a"));
    w.say(
      "a",
      user("add a header", 10),
      start(11),
      edit("t1"),
      { type: "tool-end", toolId: "t1" },
      { type: "tool-start", toolId: "t2", name: "Bash", input: {}, kind: "execute" },
      { type: "tool-end", toolId: "t2", isError: true },
      end(20),
    );
    w.status("a", "working", "idle");
    expect(w.wt("a").lastTurn).toMatchObject({ end: "done", facts: { turns: 1, edits: 1, toolErrors: 1 } });
    expect(isUnseen(w.wt("a"))).toBe(true);
    expect(w.settled.map(([id, t]) => `${id} ${t.end}`)).toEqual(["a done"]);
    w.turns.markSeen("a");
    expect(isUnseen(w.wt("a"))).toBe(false);
  });

  test("blocked on a question is a stop of its own, and answering it moves the record on", () => {
    const w = world(record("a"));
    w.say("a", user("pick a port", 10), start(11), {
      type: "agent-question",
      id: "q1",
      message: "Which port?",
      questions: [],
      ts: 12,
    });
    w.status("a", "working", "waiting");
    expect(w.wt("a").lastTurn).toMatchObject({ end: "asking", facts: { ask: "Which port?" } });
    expect(isUnseen(w.wt("a"))).toBe(true);
    w.say("a", { type: "agent-ask-end", id: "q1", outcome: "answered", ts: 13 }, end(14));
    w.status("a", "working", "idle");
    expect(w.wt("a").lastTurn?.end).toBe("done");
    expect(w.wt("a").lastTurn?.facts.ask).toBeUndefined();
  });

  test("a failure is stamped with its error, and a refused login says that is why", () => {
    const w = world(record("a"), record("b"));
    w.say("a", user("go", 10), start(11), { type: "agent-error", message: "rate limited", ts: 12 });
    w.say("b", user("go", 10), start(11), auth);
    w.status("a", "working", "error");
    w.status("b", "working", "error");
    expect(w.wt("a").lastTurn).toMatchObject({ end: "failed", facts: { error: "rate limited" } });
    expect(w.wt("b").lastTurn).toMatchObject({ end: "failed", facts: { auth: true } });
  });

  test("a stop asked for through toyon is already seen; an interrupted turn nobody asked about still rings", () => {
    const w = world(record("a"), record("b"));
    for (const id of ["a", "b"]) w.say(id, user("go", 10), start(11), end(12, "interrupted"));
    w.turns.stoppedByPerson("a");
    w.status("a", "working", "idle");
    w.status("b", "working", "idle");
    expect(w.wt("a").lastTurn?.end).toBe("stopped");
    expect(isUnseen(w.wt("a"))).toBe(false);
    expect(w.wt("b").lastTurn?.end).toBe("stopped");
    expect(isUnseen(w.wt("b"))).toBe(true);
  });

  test("the facts cover every turn since the last look, and none from before it", () => {
    const w = world(record("a", { seenAt: 15 }));
    w.say(
      "a",
      ...[user("old", 1), start(2), edit("t0"), end(5)],
      ...[user("one", 20), start(21), edit("t1"), end(25)],
      ...[user("two", 30), start(31), edit("t2"), edit("t3"), end(35)],
    );
    w.status("a", "working", "idle");
    expect(w.wt("a").lastTurn?.facts).toMatchObject({ turns: 2, edits: 3 });
  });

  test("idle at birth, a spare, and a worktree removed mid-turn stamp nothing", () => {
    const w = world(record("a"), record("s", { kind: "spare" }));
    w.status("a", "idle");
    w.status("s", "working", "idle");
    w.status("gone", "working", "idle");
    expect(w.wt("a").lastTurn).toBeUndefined();
    expect(w.wt("s").lastTurn).toBeUndefined();
    expect(w.settled).toEqual([]);
  });

  test("marking unread rings a row with no turns, and looking clears the mark", () => {
    const w = world(record("a"));
    expect(isUnseen(w.wt("a"))).toBe(false);
    w.turns.markUnread("a");
    expect(isUnseen(w.wt("a"))).toBe(true);
    w.turns.markSeen("a");
    expect(isUnseen(w.wt("a"))).toBe(false);
    expect(w.wt("a").unread).toBeUndefined();
  });
});

// Timers run for real at 20ms: the service arms one per stop, and a test waits past it.
describe("recaps", () => {
  const DELAY = 20;
  const past = () => Bun.sleep(DELAY * 3);
  const finish = (w: ReturnType<typeof world>, id: string) => {
    w.say(id, user("add a header", 10), start(11), edit(`${id}1`), { type: "text-delta", text: "Added it." }, end(20));
    w.status(id, "working", "idle");
  };

  test("an unseen stop gets its recap after the delay: the facts at once, then the sentence", async () => {
    const prompts: string[] = [];
    let answer: (text: string | null) => void = () => {};
    const w = build(
      {
        delayMs: DELAY,
        summarize: (_wt, prompt) => {
          prompts.push(prompt);
          return new Promise((r) => {
            answer = r;
          });
        },
      },
      [record("a", { title: "sticky-header" })],
    );
    finish(w, "a");
    expect(w.wt("a").lastTurn?.recap).toBeUndefined();
    await past();
    expect(w.wt("a").lastTurn?.recap?.at).toBeNumber();
    expect(w.wt("a").lastTurn?.recap?.text).toBeUndefined();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Task: sticky-header");
    expect(prompts[0]).toContain("You asked: add a header");
    expect(prompts[0]).toContain("Agent ended with: Added it.");
    answer("Adding a sticky header; it is in, so check the page next.");
    await Bun.sleep(5);
    expect(w.wt("a").lastTurn?.recap?.text).toBe("Adding a sticky header; it is in, so check the page next.");
  });

  test("looking before the delay, or another turn starting, means no recap and no call", async () => {
    let calls = 0;
    const summarize = async () => {
      calls++;
      return "a b c";
    };
    const w = build({ delayMs: DELAY, summarize }, [record("a"), record("b")]);
    finish(w, "a");
    finish(w, "b");
    w.turns.markSeen("a");
    w.status("b", "working");
    await past();
    expect(w.wt("a").lastTurn?.recap).toBeUndefined();
    expect(w.wt("b").lastTurn?.recap).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("facts only, a refused login, or no sentence back: the recap is due and carries no text", async () => {
    let calls = 0;
    const summarize = async () => {
      calls++;
      return null;
    };
    const w = build({ delayMs: DELAY, summarize }, [record("a"), record("b"), record("c")]);
    w.state.setPrefs({ recaps: "facts" });
    finish(w, "a");
    await past();
    w.state.setPrefs({ recaps: "summarize" });
    w.say("b", user("go", 10), start(11), auth);
    w.status("b", "working", "error");
    finish(w, "c");
    await past();
    for (const id of ["a", "b", "c"]) {
      expect(w.wt(id).lastTurn?.recap?.at).toBeNumber();
      expect(w.wt(id).lastTurn?.recap?.text).toBeUndefined();
    }
    // only c was asked, and nothing came back
    expect(calls).toBe(1);
  });

  test("a sentence for a stop that has been replaced is dropped, and the same time away asks once", async () => {
    const answers: Array<(text: string | null) => void> = [];
    const w = build(
      {
        delayMs: DELAY,
        summarize: () => new Promise((r) => answers.push(r)),
      },
      [record("a")],
    );
    finish(w, "a");
    await past();
    expect(answers).toHaveLength(1);
    // a queued turn runs and stops while the first sentence is still being written
    w.say("a", user("and a footer", 30), start(31), end(40));
    w.status("a", "working", "idle");
    answers[0]!("Adding a header; check it next.");
    await past();
    expect(w.wt("a").lastTurn?.recap?.at).toBeNumber();
    expect(w.wt("a").lastTurn?.recap?.text).toBeUndefined();
    expect(answers).toHaveLength(1);
  });

  test("after a restart an unseen stop has its facts recap, and a question nobody can answer is a stop", () => {
    const facts = { turns: 1, edits: 2, toolErrors: 0 };
    const w = world(
      record("a", { lastTurn: { at: 5, end: "asking", facts: { ...facts, ask: "Which port?" } } }),
      record("b", { lastTurn: { at: 5, end: "done", facts }, seenAt: 9 }),
    );
    expect(w.wt("a").lastTurn).toMatchObject({ end: "stopped", recap: { at: expect.any(Number) } });
    expect(w.wt("a").lastTurn?.facts.ask).toBeUndefined();
    expect(w.wt("b").lastTurn?.recap).toBeUndefined();
  });
});
