import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "./errors.ts";
import { collectRefs, cssRefs, FRAME_REFS_MAX, FRAME_TTL_MS, FrameTickets, keyOf, plainFile } from "./frames.ts";

// A ticket reads its page and the files the page names, nothing else: decided when it is minted
// from a real folder, and checked again when a file is served.

let base: string;
let root: string;
beforeAll(() => {
  // canonical, as the tickets hold a root: /var is a link to /private/var here
  base = realpathSync(mkdtempSync(join(tmpdir(), "toyon-frames-")));
  root = join(base, "wt");
  for (const d of ["img", "fonts", "sub/deep", "home/pics", "home/a/b"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(base, "out.png"), "png");
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, "state.json"), "{}");
  for (const f of ["img/a.png", "img/a b.png", "img/b.png", "unnamed.png", "sub/deep/x.png", "fonts/f.woff2"]) {
    writeFileSync(join(root, f), "bytes");
  }
  writeFileSync(join(root, "more.css"), "body{}");
  writeFileSync(
    join(root, "style.css"),
    `@import "more.css"; .a{background:url("fonts/f.woff2")} .b{background:url(img/b.png)}`,
  );
  writeFileSync(join(root, "other.html"), "<p>other</p>");
  writeFileSync(join(root, "script.js"), "alert(1)");
  symlinkSync(join(root, ".env"), join(root, "logo.png"));
  writeFileSync(
    join(root, "page.html"),
    [
      '<link rel="stylesheet" href="style.css">',
      '<img src="img/a.png"><img src="img/a%20b.png"><img src="missing.png">',
      '<img src="logo.png"><img src=".env"><img src="../out.png"><img src="/unnamed.png">',
      '<img src="sub/deep/x.png"><img src="https://example.com/x.png"><img src="#frag">',
      '<a href="other.html">x</a><link rel="preload" href="script.js"><object data="other.html"></object>',
      '<video poster="img/b.png" src="clip.mp4"></video><script src="script.js"></script>',
    ].join("\n"),
  );
  writeFileSync(
    join(root, "home/notes.html"),
    '<img src="pics/x.png"><img src="a/b/c.png"><img src="../img/a.png"><img src="state.json"><link href="s.css">',
  );
  writeFileSync(join(root, "home/pics/x.png"), "png");
  writeFileSync(join(root, "home/a/b/c.png"), "png");
  writeFileSync(join(root, "home/state.json"), "{}");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

let now = 1_000_000;
const tickets = () =>
  new FrameTickets({
    worktreeRoot: (id) => (id === "wt1" ? root : null),
    grantPath: (id) => (id === "g1" ? join(root, "home/notes.html") : id === "g2" ? join(root, "script.js") : null),
    refused: [join(root, "home/state.json")],
    now: () => now,
  });

describe("keyOf", () => {
  test("resolves as the browser does under the page: folders folded, query and fragment dropped, segments decoded", () => {
    expect(keyOf("docs", "img/a%20b.png?x=1#y", "page.html")).toBe("docs/img/a b.png");
    expect(keyOf("docs", "../img/a.png", "page.html")).toBe("img/a.png");
    expect(keyOf("docs", "%2e%2e/x.png", "page.html")).toBe("x.png");
    expect(keyOf("", "img\\a.png", "page.html")).toBe("img/a.png");
    expect(keyOf("", "./a.png", "page.html")).toBe("a.png");
  });
  test("nothing above the ticket, on another origin, absolute, a fragment, a dot name, or a bad escape", () => {
    expect(keyOf("", "../out.png", "page.html")).toBeNull();
    expect(keyOf("", "https://example.com/x.png", "page.html")).toBeNull();
    expect(keyOf("", "//example.com/x.png", "page.html")).toBeNull();
    expect(keyOf("", "/unnamed.png", "page.html")).toBeNull();
    expect(keyOf("", "#frag", "page.html")).toBeNull();
    expect(keyOf("", "", "page.html")).toBeNull();
    expect(keyOf("", ".env", "page.html")).toBeNull();
    expect(keyOf("", ".git/config", "page.html")).toBeNull();
    expect(keyOf("", "img/%zz.png", "page.html")).toBeNull();
    expect(keyOf("", "a%2Fb.png", "page.html")).toBeNull();
    expect(keyOf("", "data:image/png;base64,AAAA", "page.html")).toBeNull();
  });
});

describe("collectRefs and cssRefs", () => {
  test("the attributes a page draws through, once each, in order; a script's source is not one", async () => {
    const html = await Bun.file(join(root, "page.html")).text();
    expect(await collectRefs(html, "page.html")).toEqual([
      "style.css",
      "img/a.png",
      "img/a b.png",
      "missing.png",
      "logo.png",
      "sub/deep/x.png",
      "script.js",
      "other.html",
      "clip.mp4",
      "img/b.png",
    ]);
  });
  test("a page in a folder names files against that folder", async () => {
    expect(await collectRefs('<img src="a.png"><img src="../b.png">', "docs/page.html")).toEqual([
      "docs/a.png",
      "b.png",
    ]);
  });
  test("a stylesheet's url() and @import, against its own folder", () => {
    expect(
      cssRefs(
        `@import "m.css"; @import url(n.css); .a{background:url("x.png")} .b{background:url('../y.png')} .c{background:url(z.png)} .d{background:url(data:image/png;base64,AA)}`,
        "css/s.css",
      ),
    ).toEqual(["css/n.css", "css/x.png", "y.png", "css/z.png", "css/m.css"]);
  });
  test("past the cap the rest is left out", async () => {
    const many = Array.from({ length: FRAME_REFS_MAX + 20 }, (_, i) => `<img src="i${i}.png">`).join("");
    expect((await collectRefs(many, "page.html")).length).toBe(FRAME_REFS_MAX);
  });
});

describe("plainFile", () => {
  test("a regular file through plain folders, and nothing else", async () => {
    expect(await plainFile(root, "img/a.png")).toBe(true);
    expect(await plainFile(root, "img")).toBe(false);
    expect(await plainFile(root, "logo.png")).toBe(false);
    expect(await plainFile(root, ".env")).toBe(false);
    expect(await plainFile(root, "missing.png")).toBe(false);
    expect(await plainFile(root, "img/../img/a.png")).toBe(false);
  });
});

describe("a worktree page's ticket", () => {
  test("reaches the files the page and its stylesheets name, of the drawn types, through plain folders", async () => {
    const t = tickets();
    const { code, page, ms } = await t.mint({ kind: "worktree", worktreeId: "wt1", path: "page.html" });
    expect(page).toBe("page.html");
    expect(ms).toBe(FRAME_TTL_MS);
    const got = t.get(code);
    expect(got).not.toBeNull();
    expect([...(got?.files ?? [])].sort()).toEqual(
      ["style.css", "img/a.png", "img/a b.png", "sub/deep/x.png", "img/b.png", "more.css", "fonts/f.woff2"].sort(),
    );
  });
  test("what it does not reach: a link named as a picture, a dot file, a script, another page, a file beside the page it never named", async () => {
    const t = tickets();
    const { code } = await t.mint({ kind: "worktree", worktreeId: "wt1", path: "page.html" });
    const got = t.get(code);
    if (!got) throw new Error("no ticket");
    for (const key of [
      "logo.png",
      ".env",
      "script.js",
      "other.html",
      "unnamed.png",
      "missing.png",
      "out.png",
      "../out.png",
    ]) {
      expect(await t.file(got, key)).toBeNull();
    }
    expect(await t.file(got, "img/a.png")).toEqual({ path: join(root, "img/a.png") });
    expect(await t.file(got, "page.html")).toEqual({ path: join(root, "page.html") });
  });
  test("a file swapped for a link after the mint is gone", async () => {
    const t = tickets();
    const { code } = await t.mint({ kind: "worktree", worktreeId: "wt1", path: "page.html" });
    const got = t.get(code);
    if (!got) throw new Error("no ticket");
    unlinkSync(join(root, "sub/deep/x.png"));
    symlinkSync(join(root, ".env"), join(root, "sub/deep/x.png"));
    try {
      expect(await t.file(got, "sub/deep/x.png")).toBeNull();
    } finally {
      unlinkSync(join(root, "sub/deep/x.png"));
      writeFileSync(join(root, "sub/deep/x.png"), "bytes");
    }
  });
  test("runs out on the clock, in use or not, and a wrong code is nothing", async () => {
    const t = tickets();
    const { code } = await t.mint({ kind: "worktree", worktreeId: "wt1", path: "page.html" });
    expect(t.get(code)).not.toBeNull();
    expect(t.get(`${code.slice(1)}A`)).toBeNull();
    now += FRAME_TTL_MS - 1;
    expect(t.get(code)).not.toBeNull();
    now += 1;
    expect(t.get(code)).toBeNull();
  });
  test("refuses what is not a page, a page that is a link, and a worktree it does not know", async () => {
    const t = tickets();
    const refused = (s: Parameters<FrameTickets["mint"]>[0]) =>
      t.mint(s).then(
        () => null,
        (e: unknown) => e,
      );
    expect(await refused({ kind: "worktree", worktreeId: "wt1", path: "script.js" })).toBeInstanceOf(UserError);
    expect(await refused({ kind: "worktree", worktreeId: "wt1", path: "logo.png" })).toBeInstanceOf(UserError);
    expect(await refused({ kind: "worktree", worktreeId: "wt1", path: "missing.html" })).toBeInstanceOf(UserError);
    expect(await refused({ kind: "worktree", worktreeId: "wt1", path: "../page.html" })).toBeInstanceOf(UserError);
    expect(await refused({ kind: "worktree", worktreeId: "nope", path: "page.html" })).toBeInstanceOf(UserError);
  });
});

describe("a loose page's ticket", () => {
  test("reaches its own folder and one below, never above, never what the daemon refuses", async () => {
    const t = tickets();
    const { code, page } = await t.mint({ kind: "loose", grantId: "g1" });
    expect(page).toBe("notes.html");
    const got = t.get(code);
    expect(got?.root).toBe(join(root, "home"));
    expect([...(got?.files ?? [])]).toEqual(["pics/x.png"]);
  });
  test("a granted file that is no page, or no grant at all, is refused", async () => {
    const t = tickets();
    await expect(t.mint({ kind: "loose", grantId: "g2" })).rejects.toBeInstanceOf(UserError);
    await expect(t.mint({ kind: "loose", grantId: "g9" })).rejects.toBeInstanceOf(UserError);
  });
});

describe("a page held as text", () => {
  test("is the page and nothing beside it", async () => {
    const t = tickets();
    const { code, page } = await t.mint({ kind: "text", text: "<p>hi</p>" });
    expect(page).toBe("page.html");
    const got = t.get(code);
    if (!got) throw new Error("no ticket");
    expect(await t.file(got, "page.html")).toEqual({ text: "<p>hi</p>" });
    expect(await t.file(got, "a.png")).toBeNull();
  });
  test("too much text is refused", async () => {
    const t = tickets();
    await expect(t.mint({ kind: "text", text: "x".repeat(5_000_001) })).rejects.toBeInstanceOf(UserError);
  });
});

describe("what the review added", () => {
  test("a hard link is refused: the file has another name whose rules are not this one's", async () => {
    linkSync(join(root, ".env"), join(root, "hard.png"));
    try {
      expect(await plainFile(root, "hard.png")).toBe(false);
      writeFileSync(join(root, "hard.html"), '<img src="hard.png"><img src="img/a.png">');
      const t = tickets();
      const { code } = await t.mint({ kind: "worktree", worktreeId: "wt1", path: "hard.html" });
      expect([...(t.get(code)?.files ?? [])]).toEqual(["img/a.png"]);
    } finally {
      unlinkSync(join(root, "hard.png"));
    }
  });
  test("a style block, a srcset and an inline svg picture name files too", async () => {
    const html =
      '<style>.a{background:url("img/a.png")} @import "more.css";</style>' +
      '<img srcset="img/b.png 1x, img/a%20b.png 2x" src="unnamed.png"><svg><image href="sub/deep/x.png"/></svg>';
    expect(await collectRefs(html, "page.html")).toEqual([
      "img/a.png",
      "more.css",
      "unnamed.png",
      "img/b.png",
      "img/a b.png",
      "sub/deep/x.png",
    ]);
  });
  test("a page minted again replaces its own ticket and leaves the others", async () => {
    const t = tickets();
    const first = (await t.mint({ kind: "worktree", worktreeId: "wt1", path: "page.html" })).code;
    const other = (await t.mint({ kind: "loose", grantId: "g1" })).code;
    const second = (await t.mint({ kind: "worktree", worktreeId: "wt1", path: "page.html" })).code;
    expect(t.get(first)).toBeNull();
    expect(t.get(second)).not.toBeNull();
    expect(t.get(other)).not.toBeNull();
  });
});
