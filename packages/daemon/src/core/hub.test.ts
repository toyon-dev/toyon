import { describe, expect, test } from "bun:test";
import { Hub } from "./hub.ts";

describe("Hub", () => {
  test("delivers synchronously to every listener and unsubscribes", () => {
    const hub = new Hub();
    const got: string[] = [];
    const off = hub.on("log", (id, proc, line) => got.push(`${id}/${proc}/${line}`));
    hub.on("log", () => got.push("second"));
    hub.emit("log", "w", "web", "ready");
    expect(got).toEqual(["w/web/ready", "second"]);
    off();
    hub.emit("log", "w", "web", "again");
    expect(got.length).toBe(3);
  });

  test("a throwing listener does not stop the others", () => {
    const hub = new Hub();
    let reached = false;
    hub.on("worktreesChanged", () => {
      throw new Error("boom");
    });
    hub.on("worktreesChanged", () => {
      reached = true;
    });
    hub.emit("worktreesChanged");
    expect(reached).toBe(true);
  });
});
