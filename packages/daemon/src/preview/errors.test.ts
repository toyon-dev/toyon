import { describe, expect, test } from "bun:test";
import { Hub } from "../core/hub.ts";
import { PageErrorService } from "./errors.ts";

function setup() {
  const hub = new Hub();
  let now = 1000;
  const known = new Set(["w1"]);
  const svc = new PageErrorService({ hub, known: (id) => known.has(id), now: () => now });
  return { svc, hub, known, tick: (ms: number) => (now += ms) };
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

  test("the same throw twice in a second is one; what is held stays at five", () => {
    const { svc, tick } = setup();
    svc.report("w1", "boom");
    tick(500);
    svc.report("w1", "boom");
    expect(svc.recent("w1")).toEqual(["boom"]);
    tick(5000);
    svc.report("w1", "boom");
    expect(svc.recent("w1")).toEqual(["boom", "boom"]);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      svc.report("w1", `error ${n}`);
      tick(2000);
    }
    expect(svc.recent("w1")).toEqual(["error 3", "error 4", "error 5", "error 6", "error 7"]);
  });

  test("an unknown worktree holds nothing, and one that goes takes what it held with it", () => {
    const { svc, hub, known } = setup();
    svc.report("w9", "boom");
    expect(svc.recent("w9")).toEqual([]);
    svc.report("w1", "boom");
    expect(svc.recent("w1")).toEqual(["boom"]);
    known.delete("w1");
    hub.emit("worktreesChanged");
    expect(svc.recent("w1")).toEqual([]);
  });
});
