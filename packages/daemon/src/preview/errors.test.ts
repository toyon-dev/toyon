import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@toyon/shared";
import { FakeAgent } from "../../test/helpers/fakes.ts";
import { Hub } from "../core/hub.ts";
import { PageErrorService } from "./errors.ts";

function setup() {
  const hub = new Hub();
  const agent = new FakeAgent("w1");
  let now = 1000;
  const known = new Set(["w1"]);
  const svc = new PageErrorService({
    hub,
    runtime: { agentFor: () => agent },
    known: (id) => known.has(id),
    now: () => now,
  });
  const heard = (event: AgentEvent) => hub.emit("agent", "w1", 0, event);
  const rows = () =>
    agent.recorded.filter((e) => e.type === "page-error").map((e) => (e as { message: string }).message);
  const write: AgentEvent = { type: "tool-start", toolId: "t1", name: "Edit", input: {}, kind: "edit" };
  const read: AgentEvent = { type: "tool-start", toolId: "t2", name: "Read", input: {}, kind: "read" };
  const run: AgentEvent = {
    type: "tool-start",
    toolId: "t3",
    name: "Bash",
    input: { command: "sed -i" },
    kind: "execute",
  };
  return { svc, hub, heard, rows, write, read, run, known, tick: (ms: number) => (now += ms) };
}

describe("PageErrorService", () => {
  test("what the page threw is held, and said behind the next message, until the page loads again", () => {
    const { svc } = setup();
    expect(svc.recent("w1")).toEqual([]);
    expect(svc.ambient("w1")).toBeUndefined();
    svc.report("w1", "DIG: fullWidth on a small button (src/Button.tsx:41)");
    svc.report("w1", "unhandled rejection: TypeError: x is undefined");
    expect(svc.ambient("w1")).toBe(
      "The preview has thrown since it last loaded:\n- DIG: fullWidth on a small button (src/Button.tsx:41)\n- unhandled rejection: TypeError: x is undefined",
    );
    svc.loaded("w1");
    expect(svc.recent("w1")).toEqual([]);
    expect(svc.ambient("w1")).toBeUndefined();
  });

  test("an error before any write of the turn is held and not put on the transcript", () => {
    const { svc, heard, rows, read } = setup();
    heard({ type: "turn-start", ts: 1 });
    heard(read);
    svc.report("w1", "boom");
    expect(svc.recent("w1")).toEqual(["boom"]);
    expect(rows()).toEqual([]);
  });

  test("the turn's first write opens the window: an error after it is a row, up to the next message", () => {
    const { svc, heard, rows, write } = setup();
    heard({ type: "turn-start", ts: 1 });
    heard(write);
    svc.report("w1", "boom");
    heard({ type: "turn-end", stopReason: "end_turn", ts: 2 });
    // the reload after the turn, and the crash that lands on it
    svc.loaded("w1");
    svc.report("w1", "crash on render");
    expect(rows()).toEqual(["boom", "crash on render"]);
    heard({ type: "user-message", text: "hm", ts: 3 });
    svc.report("w1", "after the message");
    expect(rows()).toEqual(["boom", "crash on render"]);
    expect(svc.recent("w1")).toEqual(["crash on render", "after the message"]);
  });

  test("Toyon's own message shuts the window the way the person's does", () => {
    const { svc, heard, rows, write } = setup();
    heard(write);
    heard({ type: "fix-asked", text: "fix it", ts: 1, kind: "page", why: "the preview threw" });
    svc.report("w1", "still broken");
    expect(rows()).toEqual([]);
  });

  test("the same throw twice in a second is one; the same message later in a window is one row", () => {
    const { svc, heard, rows, write, tick } = setup();
    heard(write);
    svc.report("w1", "boom");
    tick(500);
    svc.report("w1", "boom");
    expect(svc.recent("w1")).toEqual(["boom"]);
    tick(5000);
    svc.report("w1", "boom");
    expect(svc.recent("w1")).toEqual(["boom", "boom"]);
    expect(rows()).toEqual(["boom"]);
  });

  test("a window writes three rows at most; what is held stays at five", () => {
    const { svc, heard, rows, write, tick } = setup();
    heard(write);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      svc.report("w1", `error ${n}`);
      tick(2000);
    }
    expect(rows()).toEqual(["error 1", "error 2", "error 3"]);
    expect(svc.recent("w1")).toEqual(["error 3", "error 4", "error 5", "error 6", "error 7"]);
    // the next turn's first write opens a window of its own
    heard({ type: "user-message", text: "again", ts: 1 });
    heard({ type: "turn-start", ts: 2 });
    heard(write);
    svc.report("w1", "error 8");
    expect(rows()).toEqual(["error 1", "error 2", "error 3", "error 8"]);
  });

  test("a command opens the window the way an edit does: it may have changed the tree", () => {
    const { svc, heard, rows, run } = setup();
    heard({ type: "turn-start", ts: 1 });
    heard(run);
    svc.report("w1", "boom");
    expect(rows()).toEqual(["boom"]);
  });

  test("an unknown worktree holds nothing, and one that goes takes what it held with it", () => {
    const { svc, hub, known } = setup();
    svc.report("w9", "boom");
    expect(svc.recent("w9")).toEqual([]);
    svc.report("w1", "boom");
    known.delete("w1");
    hub.emit("worktreesChanged");
    expect(svc.recent("w1")).toEqual([]);
  });

  test("a worktree with no agent holds the error and writes nothing", () => {
    const hub = new Hub();
    const svc = new PageErrorService({ hub, runtime: { agentFor: () => undefined }, known: () => true });
    hub.emit("agent", "w1", 0, { type: "tool-start", toolId: "t1", name: "Write", input: {}, kind: "edit" });
    svc.report("w1", "boom");
    expect(svc.recent("w1")).toEqual(["boom"]);
  });
});
