import { describe, expect, test } from "bun:test";
import { closePendingLink, PENDING_LINK } from "./linkTail.ts";

describe("a link still being written", () => {
  test("is closed on the placeholder while its url streams", () => {
    expect(closePendingLink("see [the docs](https://exam")).toBe(`see [the docs](${PENDING_LINK})`);
    expect(closePendingLink("see [the docs](")).toBe(`see [the docs](${PENDING_LINK})`);
    expect(closePendingLink("see ![a picture](https://exam")).toBe(`see [a picture](${PENDING_LINK})`);
  });

  test("is closed while its label streams", () => {
    expect(closePendingLink("see [the do")).toBe(`see [the do](${PENDING_LINK})`);
    expect(closePendingLink("see [")).toBe(`see [](${PENDING_LINK})`);
  });

  test("keeps everything before it, including earlier finished links", () => {
    const text = "one [a](https://a.example) and\n\ntwo [b](https://b.exa";
    expect(closePendingLink(text)).toBe(`one [a](https://a.example) and\n\ntwo [b](${PENDING_LINK})`);
  });
});

describe("text that is not an unfinished link", () => {
  test("a finished link, a bare bracket pair, a checkbox", () => {
    for (const text of [
      "see [the docs](https://example.com)",
      "see [the docs]",
      "- [ ] a task",
      "- [x] done",
      "plain",
    ]) {
      expect(closePendingLink(text)).toBe(text);
    }
  });

  test("a bracket inside a code span or an open fence", () => {
    expect(closePendingLink("the `arr[0")).toBe("the `arr[0");
    expect(closePendingLink("```ts\nconst a = b[")).toBe("```ts\nconst a = b[");
    expect(closePendingLink("```ts\nx\n```\nsee [the do")).toBe(`\`\`\`ts\nx\n\`\`\`\nsee [the do](${PENDING_LINK})`);
  });

  test("a bracket on an earlier line", () => {
    expect(closePendingLink("see [the do\nnext line")).toBe("see [the do\nnext line");
  });
});
