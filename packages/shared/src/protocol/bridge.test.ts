import { describe, expect, test } from "bun:test";
import { parseBridgeMsg } from "./bridge.ts";

describe("bridge messages", () => {
  test("a page's links are bounded: the page is untrusted", () => {
    const links = (list: unknown) => parseBridgeMsg({ __toyon: true, type: "links", links: list });
    expect(links([{ path: "/pricing", text: "Pricing" }])).toEqual({
      type: "links",
      links: [{ path: "/pricing", text: "Pricing" }],
    });
    expect(links(Array.from({ length: 201 }, () => ({ path: "/a", text: "" })))).toBeNull();
    expect(links([{ path: "/a", text: "x".repeat(121) }])).toBeNull();
    expect(links([{ path: `/${"x".repeat(2048)}`, text: "" }])).toBeNull();
  });

  test("a navigation may come without a title from an older bridge, and a title can arrive on its own", () => {
    expect(parseBridgeMsg({ __toyon: true, type: "navigated", url: "http://x/a" })).toEqual({
      type: "navigated",
      url: "http://x/a",
    });
    expect(parseBridgeMsg({ __toyon: true, type: "title", title: "Pricing" })).toEqual({
      type: "title",
      title: "Pricing",
    });
  });
});
