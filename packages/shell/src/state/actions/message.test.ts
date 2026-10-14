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

  // the Finder rows read the daemon's host to know the disk is this machine's; with no socket
  // that is the page's, and the test has no page
  const onThisMachine = () =>
    Object.defineProperty(globalThis, "location", { value: { hostname: "localhost" }, configurable: true });
  const sockTo = (host: string, sent: unknown[]) =>
    ({ send: (m: unknown) => sent.push(m), urls: { host } }) as unknown as Deps["sock"];
  const press = (items: ReturnType<typeof messageItems>, id: string) =>
    items
      .filter(isItem)
      .find((i) => i.id === id)
      ?.onClick();

  test("a link to a worktree file is about the file: the open the press makes, Finder, then its path", () => {
    onThisMachine();
    const sent: unknown[] = [];
    const sock = sockTo("localhost", sent);
    const link = { kind: "file", file: { path: "src/ui", folder: true } } as const;
    const items = messageItems({ kind: "assistant", text: "see" }, "w", { sock, dispatch: () => {} }, { link });
    expect(ids(items)).toEqual(["open", "reveal", "copy-path", "copy"]);
    press(items, "reveal");
    expect(sent).toEqual([{ t: "reveal", worktreeId: "w", path: "src/ui" }]);
    // with no worktree there is nothing to open the file in and no row to reveal it through
    expect(ids(messageItems({ kind: "assistant", text: "see" }, null, deps, { link }))).toEqual(["copy-path", "copy"]);
  });

  test("a link to a file outside the worktree opens by its absolute path, and is revealed by it", () => {
    onThisMachine();
    const sent: unknown[] = [];
    const sock = sockTo("localhost", sent);
    const link = {
      kind: "outside",
      href: "/Users/me/.cache/out.csv:3",
      path: "/Users/me/.cache/out.csv",
      line: 3,
    } as const;
    const items = messageItems({ kind: "assistant", text: "see" }, "w", { sock, dispatch: () => {} }, { link });
    expect(ids(items)).toEqual(["open", "reveal", "copy-path", "copy"]);
    press(items, "open");
    press(items, "reveal");
    expect(sent).toEqual([
      { t: "open-by-path", path: "/Users/me/.cache/out.csv", seq: expect.any(Number) },
      { t: "reveal-path", path: "/Users/me/.cache/out.csv" },
    ]);
  });

  test("a backticked path has the file's menu: opened by the path itself, which a refusal comes back to", () => {
    onThisMachine();
    const sent: unknown[] = [];
    const sock = sockTo("localhost", sent);
    const link = { kind: "path", path: "/Users/me/.cache/driver.mjs" } as const;
    const items = messageItems({ kind: "assistant", text: "see" }, "w", { sock, dispatch: () => {} }, { link });
    expect(ids(items)).toEqual(["open", "reveal", "copy-path", "copy"]);
    press(items, "open");
    expect(sent).toEqual([{ t: "open-by-path", path: "/Users/me/.cache/driver.mjs", seq: expect.any(Number) }]);
  });

  test("from another device the open stays, since Toyon makes it, and Finder goes", () => {
    const sock = sockTo("toyon.example.com", []);
    const link = { kind: "outside", href: "/Users/me/a.md", path: "/Users/me/a.md" } as const;
    const items = messageItems({ kind: "assistant", text: "see" }, "w", { sock, dispatch: () => {} }, { link });
    expect(ids(items)).toEqual(["open", "copy-path", "copy"]);
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
