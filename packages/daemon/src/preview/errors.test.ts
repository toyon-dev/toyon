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
    agent.recorded.filter((e) => e.type === "page-error").map((e) => (e as { errors: string[] }).errors);
  const start: AgentEvent = { type: "turn-start", ts: 1 };
  const end: AgentEvent = { type: "turn-end", stopReason: "end_turn", ts: 2 };
  return { svc, hub, heard, rows, start, end, known, tick: (ms: number) => (now += ms) };
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

  test("while the agent is idle a throw is a row as it comes: the person met it by hand", () => {
    const { svc, rows, tick } = setup();
    svc.report("w1", "boom");
    expect(rows()).toEqual([["boom"]]);
    tick(5000);
    svc.report("w1", "TypeError: x is undefined");
    expect(rows()).toEqual([["boom"], ["TypeError: x is undefined"]]);
  });

  test("during a turn nothing is a row: what the page still throws at the end is one row", () => {
    const { svc, heard, rows, start, end, tick } = setup();
    heard(start);
    // the dev server swaps each edit in, and the half-written ones throw
    svc.report("w1", "draft one");
    svc.loaded("w1");
    tick(2000);
    svc.report("w1", "draft two");
    expect(rows()).toEqual([]);
    // the last edit's swap: what the page is left throwing
    svc.loaded("w1");
    tick(2000);
    svc.report("w1", "unhandled rejection: TypeError: x");
    svc.report("w1", "Uncaught ReferenceError: y is not defined (src/a.ts:12)");
    heard(end);
    expect(rows()).toEqual([
      ["unhandled rejection: TypeError: x", "Uncaught ReferenceError: y is not defined (src/a.ts:12)"],
    ]);
    // the crash that lands a moment after the turn, on the reload it caused
    svc.loaded("w1");
    svc.report("w1", "crash on render");
    expect(rows()).toHaveLength(2);
    expect(rows().at(-1)).toEqual(["crash on render"]);
  });

  test("a turn that leaves the page clean writes nothing", () => {
    const { svc, heard, rows, start, end } = setup();
    heard(start);
    svc.report("w1", "draft");
    svc.loaded("w1");
    heard(end);
    expect(rows()).toEqual([]);
  });

  test("a turn that fails ends the way one that finishes does", () => {
    const { svc, heard, rows, start } = setup();
    heard(start);
    svc.report("w1", "boom");
    heard({ type: "agent-error", message: "API Error: 529", ts: 3 });
    expect(rows()).toEqual([["boom"]]);
    svc.report("w1", "after");
    expect(rows()).toEqual([["boom"], ["after"]]);
  });

  test("the same throw twice in a second is one; a throw that stays is one row until the next message", () => {
    const { svc, heard, rows, tick } = setup();
    svc.report("w1", "boom");
    tick(500);
    svc.report("w1", "boom");
    expect(svc.recent("w1")).toEqual(["boom"]);
    // a reload brings it back; the person has read it once already
    svc.loaded("w1");
    tick(5000);
    svc.report("w1", "boom");
    expect(svc.recent("w1")).toEqual(["boom"]);
    expect(rows()).toEqual([["boom"]]);
    // a message means the agent hears it anyway, and the next sighting is news again
    heard({ type: "user-message", text: "hm", ts: 3 });
    svc.loaded("w1");
    svc.report("w1", "boom");
    expect(rows()).toEqual([["boom"], ["boom"]]);
  });

  test("Toyon's own message starts the count over the way the person's does", () => {
    const { svc, heard, rows } = setup();
    svc.report("w1", "still broken");
    heard({ type: "fix-asked", text: "fix it", ts: 1, kind: "page", why: "the preview threw" });
    svc.loaded("w1");
    svc.report("w1", "still broken");
    expect(rows()).toEqual([["still broken"], ["still broken"]]);
  });

  test("three rows at most between messages; what is held stays at five", () => {
    const { svc, rows, tick } = setup();
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      svc.report("w1", `error ${n}`);
      tick(2000);
    }
    expect(rows()).toEqual([["error 1"], ["error 2"], ["error 3"]]);
    expect(svc.recent("w1")).toEqual(["error 3", "error 4", "error 5", "error 6", "error 7"]);
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
    svc.report("w1", "boom");
    expect(svc.recent("w1")).toEqual(["boom"]);
  });
});
