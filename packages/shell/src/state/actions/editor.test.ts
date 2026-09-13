import { describe, expect, test } from "bun:test";
import { editorItems, openedOnDaemonMachine } from "./editor.ts";

// An editor link names a path on the daemon's disk and opens wherever the browser is, so it only
// means something when the page is open on the daemon's own machine.

describe("editor links", () => {
  test("a loopback page is on the daemon's machine; a public name or a tailnet name is not", () => {
    for (const here of ["127.0.0.1", "localhost", "[::1]", "toyon.localhost", "w3.toyon.localhost"]) {
      expect(openedOnDaemonMachine(here)).toBe(true);
    }
    for (const away of ["toyon.example.com", "box.tail1234.ts.net", "app.fly.dev", "192.168.1.20"]) {
      expect(openedOnDaemonMachine(away)).toBe(false);
    }
  });

  test("on the daemon's machine every editor and the Finder reveal are offered", () => {
    const ids = editorItems("/w/src/a.ts", () => {}, "toyon.localhost").map((i) => i.id);
    expect(ids).toEqual(["open:zed", "open:vscode", "open:cursor", "reveal"]);
  });

  test("from another device nothing is offered, since nothing there could open", () => {
    expect(editorItems("/w/src/a.ts", () => {}, "toyon.example.com")).toEqual([]);
  });
});
