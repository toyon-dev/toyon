import { describe, expect, test } from "bun:test";
import { isItem } from "../../ui/menu.ts";
import type { Deps } from "./deps.ts";
import { fileItems, imageItems, linkOpener, messageItems, pasteItems } from "./message.ts";

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

  test("a worktree named in a message opens its row, or an archived one its page, and gives its branch", () => {
    const sent: unknown[] = [];
    const d = { sock: null, dispatch: (a: unknown) => sent.push(a) };
    const live = { kind: "worktree", id: "r2", branch: "toyon/stay-awake", archived: false } as const;
    const items = messageItems({ kind: "assistant", text: "see" }, "w", d, { link: live });
    expect(ids(items)).toEqual(["open", "copy-branch", "copy"]);
    expect(items.filter(isItem).find((i) => i.id === "open")?.label).toBe("open chat");
    items
      .filter(isItem)
      .find((i) => i.id === "open")
      ?.onClick?.();
    expect(sent).toEqual([{ a: "activate", id: "r2" }]);
    const gone = messageItems({ kind: "user", text: "see" }, null, d, { link: { ...live, archived: true } });
    expect(ids(gone)).toEqual(["open", "copy-branch", "copy"]);
    gone
      .filter(isItem)
      .find((i) => i.id === "open")
      ?.onClick?.();
    expect(sent[1]).toEqual({ a: "open-archived", id: "r2" });
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

  test("a link to a folder outside the worktree is shown in Finder: by its press, and by its menu alone", () => {
    onThisMachine();
    const sent: unknown[] = [];
    const sock = sockTo("localhost", sent);
    const d = { sock, dispatch: () => {} };
    const link = {
      kind: "outside",
      href: "/Users/me/notes/mocks/",
      path: "/Users/me/notes/mocks",
      folder: true,
    } as const;
    const items = messageItems({ kind: "assistant", text: "see" }, "w", d, { link });
    expect(ids(items)).toEqual(["reveal", "copy-path", "copy"]);
    linkOpener(link, "w", d)?.();
    expect(sent).toEqual([{ t: "reveal-path", path: "/Users/me/notes/mocks" }]);
    // the reveal needs no worktree to stand in, only the daemon's own screen
    expect(linkOpener(link, null, d)).not.toBeNull();
    const away = { sock: sockTo("toyon.example.com", []), dispatch: () => {} };
    expect(linkOpener(link, "w", away)).toBeNull();
    expect(ids(messageItems({ kind: "assistant", text: "see" }, "w", away, { link }))).toEqual(["copy-path", "copy"]);
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

  // a sent chip reaches the daemon's copy through the socket, which also says whose disk it is on
  const keptOn = (host: string, sent: unknown[]) => ({
    worktreeId: "w",
    file: "1-foo.csv",
    sock: {
      send: (m: unknown) => sent.push(m),
      urls: { host, attachmentWhere: (id: string, file: string) => `/attachments/${id}/${file}?where` },
    } as unknown as Deps["sock"],
  });
  const press = (items: ReturnType<typeof fileItems>, id: string) =>
    items
      .filter(isItem)
      .find((i) => i.id === id)
      ?.onClick();

  test("a sent file or image is also about the daemon's copy: Finder beside the open, then its path", () => {
    const sent: unknown[] = [];
    const kept = keptOn("127.0.0.1", sent);
    const items = fileItems({ href: "/attachments/w/1-foo.csv" }, { open: () => {} }, kept);
    expect(ids(items)).toEqual(["copy-text", "open", "reveal", "copy-path"]);
    // the label says it is the copy: the dragged file is wherever it was, and Finder cannot reach it
    expect(items.filter(isItem).find((i) => i.id === "reveal")?.label).toBe("reveal the copy");
    press(items, "reveal");
    expect(sent).toEqual([{ t: "reveal-attachment", worktreeId: "w", file: "1-foo.csv" }]);
    // a file that does not read as text still has a place on disk
    expect(ids(fileItems({}, {}, kept))).toEqual(["reveal", "copy-path"]);
    expect(ids(imageItems("/attachments/w/1.png", {}, { ...kept, file: "1.png" }))).toEqual([
      "copy-image",
      "reveal",
      "copy-path",
    ]);
  });

  test("from another device the path stays and Finder goes; a chip not sent yet has neither", () => {
    expect(ids(fileItems({ href: "/attachments/w/1-foo.csv" }, {}, keptOn("toyon.example.com", [])))).toEqual([
      "copy-text",
      "copy-path",
    ]);
    expect(ids(fileItems({ href: "/uploads/u1" }, { remove: () => {} }))).toEqual(["copy-text", "remove"]);
  });
});
