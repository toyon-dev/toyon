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
  let refusals = 0;
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
    refusal: async () => {
      refusals++;
      return refusal;
    },
    go: () => {
      restarts++;
    },
  });
  const set = (id: string, s: AgentStatus) => {
    status.set(id, s);
    hub.emit("agentStatus", id, s);
  };
  return { restarter, set, restarts: () => restarts, changes: () => changes, refusals: () => refusals };
}

describe("Restarter", () => {
  test("with no chat mid-reply the restart happens at once", async () => {
    const { restarter, restarts } = make();
    expect(await restarter.request()).toBeNull();
    expect(restarts()).toBe(1);
    expect(restarter.waitingOn()).toEqual([]);
  });

  test("a chat mid-reply is waited out, and the restart follows the last one settling", async () => {
    const { restarter, set, restarts } = make();
    set("a", "working");
    await restarter.request();
    expect(restarts()).toBe(0);
    expect(restarter.waitingOn()).toEqual(["fix login"]);
    set("b", "working");
    expect(restarter.waitingOn()).toEqual(["fix login", "docs"]);
    set("a", "idle");
    expect(restarts()).toBe(0);
    set("b", "idle");
    expect(restarts()).toBe(1);
  });

  test("a chat stopped on a question does not hold the restart", async () => {
    const { restarter, set, restarts } = make();
    set("a", "waiting");
    await restarter.request();
    expect(restarts()).toBe(1);
  });

  test("the chats stopped on a question are named apart from the ones replying", () => {
    const { restarter, set } = make();
    set("a", "waiting");
    set("b", "working");
    expect(restarter.asking()).toEqual(["fix login"]);
    expect(restarter.working()).toEqual(["docs"]);
  });

  test("asking twice is one restart", async () => {
    const { restarter, set, restarts } = make();
    set("a", "working");
    await restarter.request();
    await restarter.request();
    set("a", "idle");
    set("a", "working");
    set("a", "idle");
    expect(restarts()).toBe(1);
  });

  test("`now` does not wait, and the chat settling later is not a second restart", async () => {
    const { restarter, set, restarts } = make();
    set("a", "working");
    await restarter.request();
    expect(restarts()).toBe(0);
    expect(await restarter.request({ now: true })).toBeNull();
    expect(restarts()).toBe(1);
    expect(restarter.waitingOn()).toEqual([]);
    set("a", "idle");
    expect(restarts()).toBe(1);
  });

  test("a refusal is the answer, and nothing waits behind it", async () => {
    const { restarter, set, restarts, refusals } = make("restart it from its terminal tab");
    set("a", "working");
    expect(await restarter.request()).toBe("restart it from its terminal tab");
    // asked before anything is given up: a daemon that cannot come back keeps serving
    expect(refusals()).toBe(1);
    set("a", "idle");
    expect(restarts()).toBe(0);
    expect(restarter.waitingOn()).toBeNull();
  });

  test("a status tick that leaves the wait as it was announces nothing", async () => {
    const { restarter, set, changes } = make();
    set("a", "working");
    await restarter.request();
    expect(changes()).toBe(1);
    set("a", "working");
    expect(changes()).toBe(1);
    set("a", "idle");
    expect(changes()).toBe(2);
  });
});
