import { expect, test } from "bun:test";
import { FRAME_QUERY } from "./app/phone.ts";
import { STORAGE } from "./state/keys.ts";

// The inline boot scripts in index.html run before any module, so they spell out the shapes the
// bundle owns that they read: the token fragment a fresh link carries, as ws.ts reads it, the
// storage keys, and the query that decides the phone frame.

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
  expect(html).toContain(`localStorage.getItem("${STORAGE.token}")`);
  expect(vite).toContain(`localStorage.setItem("${STORAGE.token}"`);
});

// the ground painted before the bundle runs is the screen's: the theme the shell cached, the
// token the screen this tab shows is painted in, and the frame the shell would draw
test("the ground script reads the theme, the screen's token and the frame as the shell spells them", () => {
  expect(html).toContain(`localStorage.getItem("${STORAGE.theme}")`);
  expect(html).toContain(`sessionStorage.getItem("${STORAGE.ground}")`);
  expect(html).toContain(`matchMedia("${FRAME_QUERY}")`);
});
