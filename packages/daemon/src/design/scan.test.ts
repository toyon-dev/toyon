import { describe, expect, test } from "bun:test";
import {
  appliedClasses,
  cssClasses,
  cssTokens,
  exportedComponents,
  importedNames,
  propUnions,
  tokenFamily,
  tokenKind,
} from "./scan.ts";

describe("tokenKind", () => {
  test("reads the value, not the name", () => {
    expect(tokenKind("#6fae5f")).toBe("color");
    expect(tokenKind("rgba(0,0,0,.4)")).toBe("color");
    expect(tokenKind("12px")).toBe("length");
    expect(tokenKind("1.5")).toBe("length");
    expect(tokenKind("ui-monospace, monospace")).toBe("font");
    expect(tokenKind("0 8px 24px #0006")).toBe("shadow");
  });

  test("a calc() is what it computes to, not a shadow with spaces in it", () => {
    expect(tokenKind("calc(var(--rail-w) - 1px)")).toBe("length");
    expect(tokenKind("var(--surface0)")).toBe("other");
  });
});

describe("tokenFamily", () => {
  test("groups a numbered rung under its family", () => {
    expect(tokenFamily("--surface0")).toBe("surface");
    expect(tokenFamily("--surface2")).toBe("surface");
    expect(tokenFamily("--r-pill")).toBe("r");
    expect(tokenFamily("--accent")).toBe("accent");
  });
});

describe("cssTokens", () => {
  test("takes the first declaration of each name", () => {
    const tokens = cssTokens(`:root { --a: #111; --b: 4px }\n[data-theme=light] { --a: #eee }`);
    expect(tokens.map((t) => [t.name, t.value])).toEqual([
      ["--a", "#111"],
      ["--b", "4px"],
    ]);
  });
});

describe("cssClasses", () => {
  test("reads selector preludes only", () => {
    expect(cssClasses(`.btn { color: red }\n.btn-icon.on { color: blue }`)).toEqual(["btn", "btn-icon", "on"]);
  });

  test("ignores at-rules and comments", () => {
    // a filename in a banner has a dot in front of an identifier exactly like a selector does
    const css = `/* see theme.ts and Kbd.tsx */\n@media (min-width: 40rem) { .wide { color: red } }`;
    expect(cssClasses(css)).toEqual(["wide"]);
  });
});

describe("exportedComponents", () => {
  test("takes exported capitalised bindings", () => {
    const src = `export function Button() {}\nexport const Menu = () => {};\nexport const SIZE = 4;\nfunction Inner() {}`;
    expect(exportedComponents(src)).toEqual(["Button", "Menu"]);
  });
});

describe("importedNames", () => {
  test("takes default and named imports, and unwraps an alias", () => {
    const src = `import React from "react";\nimport { Menu, Overlay as O } from "./ui.ts";\nimport type { Props } from "./t.ts";`;
    const names = importedNames(src);
    expect(names).toContain("React");
    expect(names).toContain("Menu");
    expect(names).toContain("Overlay");
    expect(names).not.toContain("O");
  });
});

describe("appliedClasses", () => {
  test("counts class attributes, not every mention of the word", () => {
    const src = `const name = row.name;\nconst el = <div className="name" />;\nlabel(name);`;
    expect(appliedClasses(src).get("name")).toBe(1);
  });

  test("pulls names out of an expression form", () => {
    const src = "<b className={`btn ${on ? \"on\" : \"\"}`} /><i className={cx('btn', 'btn-icon')} />";
    const counts = appliedClasses(src);
    expect(counts.get("btn")).toBe(2);
    expect(counts.get("on")).toBe(1);
    expect(counts.get("btn-icon")).toBe(1);
  });
});

describe("propUnions", () => {
  // the real service loads this from the target repo; the daemon's own copy stands in here
  const ts = require("typescript");

  test("takes string-literal unions and drops the undefined an optional prop carries", () => {
    const src = `interface Props { variant?: "primary" | "outline" | undefined; size: "sm" | "lg"; label: string }`;
    expect(propUnions(ts, "a.tsx", src)).toEqual([
      { prop: "variant", values: ["primary", "outline"], unused: [] },
      { prop: "size", values: ["sm", "lg"], unused: [] },
    ]);
  });

  test("ignores a union that is not all string literals", () => {
    const src = `interface Props { n: 1 | 2; s: string | null }`;
    expect(propUnions(ts, "a.tsx", src)).toEqual([]);
  });
});
