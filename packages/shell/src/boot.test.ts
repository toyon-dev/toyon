import { expect, test } from "bun:test";

// The inline boot script in index.html runs before any module, so it spells out the one shape
// shared owns that it reads: the token fragment a fresh link carries, as ws.ts reads it.

const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

test("the boot script reads the token fragment, and nothing else from the address", () => {
  expect(html).toContain("/token=([a-f0-9]+)/");
  expect(html).not.toContain("pair=");
  expect(html).not.toContain("toyon.cloud");
});
