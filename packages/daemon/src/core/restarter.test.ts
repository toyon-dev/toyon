import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "@toyon/shared";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { Hub } from "./hub.ts";
import { Restarter } from "./restarter.ts";
import type { StateStore } from "./state.ts";

function make(refusal: string | null = null) {
  const hub = new Hub();
  const status = new Map<string, AgentStatus>();
  const worktrees = [
    { id: "a", title: "fix login" },
    { id: "b", title: "docs" },
  ];
  let restarts = 0;
  let changes = 0;
  hub.on("updateChanged", () => changes++);
  const restarter = new Restarter({
    hub,
    state: { worktrees } as unknown as Pick<StateStore, "worktrees">,
    runtime: {
      agentFor: (id: string) => {
        const s = status.get(id);
        return s ? { status: s } : undefined;
      },
    } as unknown as Pick<RuntimeRegistry, "agentFor">,
    refusal: () => refusal,
    go: () => {
      restarts++;
    },
  });
  const set = (id: string, s: AgentStatus) => {
    status.set(id, s);
    hub.emit("agentStatus", id, s);
  };
  return { restarter, set, restarts: () => restarts, changes: () => changes };
}

describe("Restarter", () => {
  test("with no chat mid-reply the restart happens at once", () => {
    const { restarter, restarts } = make();
    expect(restarter.request()).toBeNull();
    expect(restarts()).toBe(1);
    expect(restarter.waitingOn()).toEqual([]);
  });

  test("a chat mid-reply is waited out, and the restart follows the last one settling", () => {
    const { restarter, set, restarts } = make();
    set("a", "working");
    restarter.request();
    expect(restarts()).toBe(0);
    expect(restarter.waitingOn()).toEqual(["fix login"]);
    set("b", "working");
    expect(restarter.waitingOn()).toEqual(["fix login", "docs"]);
    set("a", "idle");
    expect(restarts()).toBe(0);
    set("b", "idle");
    expect(restarts()).toBe(1);
  });

  test("a chat stopped on a question does not hold the restart", () => {
    const { restarter, set, restarts } = make();
    set("a", "waiting");
    restarter.request();
    expect(restarts()).toBe(1);
  });

  test("asking twice is one restart", () => {
    const { restarter, set, restarts } = make();
    set("a", "working");
    restarter.request();
    restarter.request();
    set("a", "idle");
    set("a", "working");
    set("a", "idle");
    expect(restarts()).toBe(1);
  });

  test("a refusal is the answer, and nothing waits behind it", () => {
    const { restarter, set, restarts } = make("restart it from its terminal tab");
    set("a", "working");
    expect(restarter.request()).toBe("restart it from its terminal tab");
    set("a", "idle");
    expect(restarts()).toBe(0);
    expect(restarter.waitingOn()).toBeNull();
  });

  test("a status tick that leaves the wait as it was announces nothing", () => {
    const { restarter, set, changes } = make();
    set("a", "working");
    restarter.request();
    expect(changes()).toBe(1);
    set("a", "working");
    expect(changes()).toBe(1);
    set("a", "idle");
    expect(changes()).toBe(2);
  });
});
