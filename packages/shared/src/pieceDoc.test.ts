import { describe, expect, test } from "bun:test";
import { leadHeading, pieceDoc } from "./pieceDoc.ts";

describe("leadHeading", () => {
  test("the text's own first heading is the page's title", () => {
    expect(leadHeading("# Move the pin\n\nOnce it is out.")).toEqual({
      title: "Move the pin",
      rest: "\nOnce it is out.",
    });
    expect(leadHeading("  ## Fork pin ##\nbody")).toEqual({ title: "Fork pin", rest: "body" });
    expect(leadHeading("# Only a title")).toEqual({ title: "Only a title", rest: "" });
    // prose first, or a heading further down, leaves the text whole
    expect(leadHeading("Point the daemon at it.\n\n# Later")).toEqual({
      title: null,
      rest: "Point the daemon at it.\n\n# Later",
    });
    // a hash with no space is not a heading
    expect(leadHeading("#1350 lands first")).toEqual({ title: null, rest: "#1350 lands first" });
  });
});

describe("pieceDoc", () => {
  test("a plan with a heading of its own is the document; one without gets the piece's title", () => {
    expect(pieceDoc({ title: "Awaits flake", plan: "# Fix the `awaits` race\n\nWait on it.\n" })).toBe(
      "# Fix the `awaits` race\n\nWait on it.\n",
    );
    expect(pieceDoc({ title: "Rail fixes", plan: "Fix the rail." })).toBe("# Rail fixes\n\nFix the rail.\n");
  });
});
