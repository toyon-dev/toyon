import { describe, expect, test } from "bun:test";
import { openedOnDaemonMachine, revealItems } from "./editor.ts";

// A Finder reveal opens on the daemon's screen, so it only means something when the page is open
// on the daemon's own machine.

describe("Finder reveal", () => {
  test("a loopback page is on the daemon's machine; a public name or a tailnet name is not", () => {
    for (const here of ["127.0.0.1", "localhost", "[::1]", "toyon.localhost", "w3.toyon.localhost"]) {
      expect(openedOnDaemonMachine(here)).toBe(true);
    }
    for (const away of ["toyon.example.com", "box.tail1234.ts.net", "app.fly.dev", "192.168.1.20"]) {
      expect(openedOnDaemonMachine(away)).toBe(false);
    }
  });

  test("on the daemon's machine the reveal is the one row, and no editor is offered", () => {
    expect(revealItems(() => {}, "toyon.localhost").map((i) => i.id)).toEqual(["reveal"]);
  });

  test("from another device nothing is offered, since nothing there could open", () => {
    expect(revealItems(() => {}, "toyon.example.com")).toEqual([]);
  });

  test("a path with no place to reveal offers nothing", () => {
    expect(revealItems(undefined, "toyon.localhost")).toEqual([]);
  });
});
