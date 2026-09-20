import { describe, expect, test } from "bun:test";
import { isItem } from "../../ui/menu.ts";
import type { Deps } from "./deps.ts";
import { imageItems, messageItems, pasteItems } from "./message.ts";

// A chip's menu is about the chip: what it holds goes onto the clipboard first, then the ways
// to act on the chip itself, which depend on where it stands. A message's menu is about the
// message, unless the pointer was on a link, which leads.

const ids = (entries: ReturnType<typeof imageItems>) => entries.filter(isItem).map((i) => i.id);
const deps = { sock: null, dispatch: () => {} };

describe("message menus", () => {
  test("a message on its own copies, and one the person wrote goes back to the composer", () => {
    expect(ids(messageItems({ kind: "assistant", text: "hi" }, "w", deps))).toEqual(["copy"]);
    expect(ids(messageItems({ kind: "user", text: "hi" }, "w", deps))).toEqual(["copy", "draft"]);
  });

  test("a link out leads with the page and its address", () => {
    const link = { kind: "out", href: "https://example.com/docs" } as const;
    expect(ids(messageItems({ kind: "assistant", text: "see" }, "w", deps, { link }))).toEqual([
      "open-out",
      "copy-link",
      "copy",
    ]);
  });

  test("a link to a worktree file is about the file: its path, not the address", () => {
    const link = { kind: "file", file: { path: "src/a.ts", line: 3 } } as const;
    // with no directory to read the path in there is no file on disk for an editor to open
    expect(ids(messageItems({ kind: "assistant", text: "see" }, "w", deps, { link, dir: null }))).toEqual([
      "copy-path",
      "copy",
    ]);
  });

  test("a path outside the worktree is a file on disk: the editors that open it, and the path as text", () => {
    // the editor rows read the page's host to know the disk is this machine's; the test has no page
    Object.defineProperty(globalThis, "location", { value: { hostname: "localhost" }, configurable: true });
    const link = { kind: "path", path: "/Users/me/.cache/driver.mjs" } as const;
    expect(ids(messageItems({ kind: "assistant", text: "see" }, "w", deps, { link, dir: null }))).toEqual([
      "open:zed",
      "open:vscode",
      "open:cursor",
      "copy-path",
      "copy",
    ]);
  });

  test("a worktree file or folder with its checkout on disk: the editors, Finder, then the path", () => {
    Object.defineProperty(globalThis, "location", { value: { hostname: "localhost" }, configurable: true });
    const sent: unknown[] = [];
    const sock = { send: (m: unknown) => sent.push(m) } as unknown as Deps["sock"];
    const link = { kind: "file", file: { path: "src/ui", folder: true } } as const;
    const items = messageItems(
      { kind: "assistant", text: "see" },
      "w",
      { sock, dispatch: () => {} },
      { link, dir: "/p" },
    );
    expect(ids(items)).toEqual(["open:zed", "open:vscode", "open:cursor", "reveal", "copy-path", "copy"]);
    items
      .filter(isItem)
      .find((i) => i.id === "reveal")
      ?.onClick();
    expect(sent).toEqual([{ t: "reveal", worktreeId: "w", path: "src/ui" }]);
  });
});

describe("attachment chip menus", () => {
  test("an image in the composer copies, opens and can be removed", () => {
    expect(ids(imageItems("data:image/png;base64,x", { open: () => {}, remove: () => {} }))).toEqual([
      "copy-image",
      "open",
      "remove",
    ]);
  });

  test("the full view keeps only the copy: it is already open and outlives the composer", () => {
    expect(ids(imageItems("/attachments/w/1.png"))).toEqual(["copy-image"]);
  });

  test("a paste copies from the composer's text or the daemon's copy, and nothing without either", () => {
    expect(ids(pasteItems({ text: "a\nb" }, { remove: () => {} }))).toEqual(["copy-text", "remove"]);
    expect(ids(pasteItems({ href: "/attachments/w/p1.txt" }, { open: () => {} }))).toEqual(["copy-text", "open"]);
    expect(ids(pasteItems({}))).toEqual([]);
  });
});
