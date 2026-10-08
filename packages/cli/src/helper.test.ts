import { describe, expect, test } from "bun:test";
import { planHelper } from "./helper.ts";

describe("planHelper", () => {
  test("a link on the scheme is a start, whatever is beside it", () => {
    expect(planHelper(["toyon://start"])).toEqual({ kind: "start" });
    expect(planHelper(["/tmp/a", "toyon://start"])).toEqual({ kind: "start" });
    expect(planHelper([])).toEqual({ kind: "start" });
  });

  test("file URLs become paths with their escapes undone; plain paths stay", () => {
    expect(planHelper(["file:///tmp/a%20b/c.txt", "/tmp/d e"])).toEqual({
      kind: "open",
      paths: ["/tmp/a b/c.txt", "/tmp/d e"],
    });
    expect(planHelper(["file://localhost/tmp/x"])).toEqual({ kind: "open", paths: ["/tmp/x"] });
  });

  test("an empty or unreadable file URL opens nothing, and nothing at all is a start", () => {
    expect(planHelper(["file://", ""])).toEqual({ kind: "start" });
    expect(planHelper(["file://", "/tmp/y"])).toEqual({ kind: "open", paths: ["/tmp/y"] });
  });
});
