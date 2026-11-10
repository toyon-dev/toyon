import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Action } from "../../state/store.ts";

// The sanitizer takes the page's window as the module loads, and a press is read off real
// elements. The window is lent for the import alone: the other suites of the run share these
// globals, and none of them expects a browser.
const page = new JSDOM("").window;
const globals = globalThis as { window?: unknown };
globals.window = page;
const { renderMarkdown } = await import("./markdown.ts");
const { openChatLink } = await import("./chatLink.ts");
delete globals.window;

const root = "/Users/me/project";

function dom(html: string): HTMLElement {
  const el = page.document.createElement("div");
  el.innerHTML = html;
  return el;
}

/** press the link of a rendered reply: whether the browser was kept from following it, and what
 * the shell was told to open */
function press(text: string, fileRoot: string | null) {
  const a = dom(renderMarkdown(text, fileRoot ? { fileRoot } : undefined)).querySelector("a");
  if (!a) throw new Error("the reply rendered no link");
  const said: Action[] = [];
  let held = false;
  const e = {
    target: a,
    preventDefault: () => {
      held = true;
    },
  };
  openChatLink(e as never, fileRoot, "wt-1", { sock: null, dispatch: (action) => said.push(action) });
  return { held, said, a };
}

describe("a press on a link in a reply", () => {
  test("opens a relative link as the worktree file, and never follows it", () => {
    const { held, said, a } = press("[Composer.tsx](packages/shell/src/Composer.tsx:12)", root);
    expect(held).toBe(true);
    expect(a.classList.contains("file-link")).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({
      a: "open-file",
      v: { worktreeId: "wt-1", path: "packages/shell/src/Composer.tsx", line: { n: 12 } },
    });
  });

  test("holds a relative link with no root to read it from", () => {
    const { held, said } = press("[Composer.tsx](packages/shell/src/Composer.tsx)", null);
    expect(held).toBe(true);
    expect(said).toEqual([]);
  });

  test("holds a protocol-relative link, which is another site in this tab", () => {
    for (const fileRoot of [root, null]) {
      const { held, said, a } = press("[x](//example.com/path)", fileRoot);
      expect(a.getAttribute("target")).toBeNull();
      expect(held).toBe(true);
      expect(said).toEqual([]);
    }
  });

  test("leaves a web link to the browser, which opens it beside the shell", () => {
    const { held, said, a } = press("[x](https://example.com/path)", root);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(held).toBe(false);
    expect(said).toEqual([]);
  });
});

describe("a document's own HTML", () => {
  const doc = (text: string) => dom(renderMarkdown(text, { keepHtml: true }));

  test("brings no stylesheet, style attribute or form into the shell", () => {
    const el = doc(
      [
        "<style>.rail { display: none }</style>",
        '<a href="https://example.com" style="position:fixed;inset:0;opacity:0" class="overlay" id="root">x</a>',
        '<form action="https://example.com"><input name="q"><button>go</button><select></select><textarea></textarea></form>',
        '<div data-worktree="wt-1" data-tip="spoofed">y</div>',
      ].join("\n\n"),
    );
    expect(el.querySelector("style, form, input, button, select, textarea")).toBeNull();
    expect(el.querySelector("[style], [id], [class], [data-worktree], [data-tip]")).toBeNull();
    expect(el.textContent).not.toContain("display: none");
    // the link itself is a link like any other
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });

  test("brings no link the page's click routing cannot see", () => {
    const el = doc(
      [
        '<img src="a.png" usemap="#m"><map name="m"><area shape="default" href="https://example.com"></map>',
        '<svg width="100" height="100"><a xlink:href="https://example.com"><text>x</text></a></svg>',
      ].join("\n\n"),
    );
    expect(el.querySelector("map, area, svg")).toBeNull();
    expect(el.innerHTML).not.toContain("example.com");
  });

  test("keeps what a README is written with", () => {
    const el = doc(
      [
        "# Toyon",
        '<p align="center"><img src="https://example.com/logo.png" width="120" alt="logo"></p>',
        "<details><summary>Install</summary>\n\nRun <kbd>bun</kbd> `install`.\n\n</details>",
        "- [x] done\n- [ ] open",
        "| a | b |\n| - | - |\n| 1 | 2 |",
        "```ts\nconst a = 1;\n```",
        "[docs](docs/remote.md) and [site](https://toyon.dev)",
      ].join("\n\n"),
    );
    expect(el.querySelector("h1")?.textContent).toBe("Toyon");
    expect(el.querySelector('p[align="center"] > img[width="120"]')?.getAttribute("alt")).toBe("logo");
    expect(el.querySelector("details > summary")?.textContent).toBe("Install");
    expect(el.querySelector("details kbd")?.textContent).toBe("bun");
    expect(el.querySelector("details code")?.textContent).toBe("install");
    const boxes = [...el.querySelectorAll('li > input[type="checkbox"]')];
    expect(boxes.map((box) => [box.hasAttribute("checked"), box.hasAttribute("disabled")])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(el.querySelector(".md-table td")?.textContent).toBe("1");
    expect(el.querySelector('pre span[class^="sy-"]')).not.toBeNull();
    expect(el.querySelector('a[href="docs/remote.md"]')).not.toBeNull();
    expect(el.querySelector('a[href="https://toyon.dev"]')?.getAttribute("target")).toBe("_blank");
  });

  test("keeps a task list's box and no other input", () => {
    const el = doc('<input type="checkbox"> <input type="text" value="typed"> <input>');
    const inputs = [...el.querySelectorAll("input")];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.hasAttribute("disabled")).toBe(true);
  });
});

describe("a reply", () => {
  test("still draws a tag as the text it is", () => {
    const el = dom(renderMarkdown('<style>.rail { display: none }</style> and <form action="/x">'));
    expect(el.querySelector("style, form")).toBeNull();
    expect(el.textContent).toContain("<style>");
  });
});
