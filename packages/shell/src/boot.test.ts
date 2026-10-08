import { expect, test } from "bun:test";

// The inline boot script in index.html runs before any module, so it spells out the one shape
// shared owns that it reads: the token fragment a fresh link carries, as ws.ts reads it.

const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
const vite = await Bun.file(new URL("../vite.config.ts", import.meta.url)).text();

test("the boot script reads the token fragment, and nothing else from the address", () => {
  expect(html).toContain("/token=([a-f0-9]+)/");
  expect(html).not.toContain("pair=");
  expect(html).not.toContain("toyon.cloud");
});

// the nested dev server writes the token where the boot script looks for it, so the key is spelled
// in both; the storage key module cannot be imported from either
test("the nested dev server saves the token under the key the boot script reads", () => {
  expect(html).toContain('localStorage.getItem("toyon-token")');
  expect(vite).toContain('localStorage.setItem("toyon-token"');
});
