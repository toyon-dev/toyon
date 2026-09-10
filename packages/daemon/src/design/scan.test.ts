import { describe, expect, test } from "bun:test";
import {
  appliedClasses,
  cssClasses,
  cssTokens,
  exportedComponents,
  importedNames,
  moduleImports,
  propUnions,
  resolveAliases,
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

  test("a font shorthand is type, not a shadow with spaces in it", () => {
    // both are three parts or more; only one of them is a shadow, and a shadow never opens with a
    // font weight. Filed as shadows, the whole type scale showed up under the wrong heading.
    expect(tokenKind("400 13px / 1.5 var(--face-ui)")).toBe("font");
    expect(tokenKind("400 11px var(--face-mono)")).toBe("font");
    expect(tokenKind("400 var(--size-mono) var(--face-mono)")).toBe("font");
    expect(tokenKind("0 8px 24px #0006")).toBe("shadow");
    expect(tokenKind("0 2px 6px rgba(0,0,0,.4)")).toBe("shadow");
  });

  test("a colour function is a colour, however many commas it has", () => {
    // this one was filed as a font stack on the strength of its commas, and shown as a specimen
    expect(tokenKind("color-mix(in srgb, var(--text0) 8%, transparent)")).toBe("color");
    expect(tokenKind("light-dark(#fff, #000)")).toBe("color");
    expect(tokenKind("oklch(0.7 0.1 200)")).toBe("color");
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

  test("takes the export-list and default-of-a-name forms", () => {
    expect(exportedComponents(`const Button = () => {};\nexport { Button };`)).toEqual(["Button"]);
    expect(exportedComponents(`export { Menu as Dropdown };`)).toEqual(["Dropdown"]);
    expect(exportedComponents(`const Foo = () => {};\nexport default Foo;`)).toEqual(["Foo"]);
  });

  test("a re-export belongs to the file it points at, not to the barrel", () => {
    expect(exportedComponents(`export { Button } from "./Button.tsx";`)).toEqual([]);
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
  const classes = (src: string) => appliedClasses(src).classes;

  test("counts class attributes, not every mention of the word", () => {
    const src = `const name = row.name;\nconst el = <div className="name" />;\nlabel(name);`;
    expect(classes(src).get("name")).toBe(1);
  });

  test("pulls names out of an expression form", () => {
    const src = "<b className={`btn ${on ? \"on\" : \"\"}`} /><i className={cx('btn', 'btn-icon')} />";
    const counts = classes(src);
    expect(counts.get("btn")).toBe(2);
    expect(counts.get("on")).toBe(1);
    expect(counts.get("btn-icon")).toBe(1);
  });

  test("reads a plain attribute, wherever the markup came from", () => {
    expect([...classes(`<button class="btn btn-outline">x</button>`).keys()]).toEqual(["btn", "btn-outline"]);
  });

  test("a template hole is the host language's, not a class", () => {
    // reporting `extra` would invent a class out of a variable name
    expect([...classes(`<div class="card {{ extra }}">`).keys()]).toEqual(["card"]);
    expect([...classes(`<div class="card <%= extra %>">`).keys()]).toEqual(["card"]);
  });

  test("a bound attribute names its classes in keys, not in its variables", () => {
    expect([...classes(`<div :class="{ active: isOn }">`).keys()]).toEqual(["active"]);
    expect([...classes(`<div [ngClass]="{ active: isOn }">`).keys()]).toEqual(["active"]);
    expect([...classes(`<b className={clsx({ on: x })} />`).keys()]).toEqual(["on"]);
  });

  test("counts the attributes it saw, so an empty result can explain itself", () => {
    const none = appliedClasses(`<b className={styles.btn} />`);
    expect(none.classes.size).toBe(0);
    expect(none.attrs).toBe(1);
    expect(appliedClasses(`const x = 1;`).attrs).toBe(0);
  });

  test("a ternary colon is not an object key", () => {
    // `styles.btnPrimary : styles.btn` was reporting a class called btnPrimary off the ternary
    const src = `<b className={on ? "a" : "b"} /><i className={x ? styles.p : styles.q} />`;
    expect([...classes(src).keys()]).toEqual(["a", "b"]);
  });

  test("reads CSS Modules through the name the file imports them as", () => {
    // the class never appears as text: the build rewrites .btn to .Button_btn__x7Fq2, and the
    // source only ever says styles.btn
    const src = [
      `import styles from "./Button.module.css";`,
      `const a = <b className={styles.btn} />;`,
      `const c = <b className={styles["btn-wide"]} />;`,
    ].join("\n");
    const counts = classes(src);
    expect(counts.get("btn")).toBe(1);
    expect(counts.get("btn-wide")).toBe(1);
  });

  test("only a name bound to a module stylesheet counts as one", () => {
    expect([...moduleImports(`import styles from "./a.module.css";`)]).toEqual(["styles"]);
    expect([...moduleImports(`import s from "./a.module.scss";`)]).toEqual(["s"]);
    // a plain stylesheet import binds nothing, and neither does an ordinary module
    expect([...moduleImports(`import "./a.css";`)]).toEqual([]);
    expect([...moduleImports(`import x from "./util.ts";`)]).toEqual([]);
  });

  test("a class that never rides alone is a modifier, not a thing", () => {
    // .btn stands on its own somewhere; .btn-outline and .on never do
    const src = `<a className="btn" /><b className="btn btn-outline" /><i className="row on" />`;
    expect([...appliedClasses(src).solo]).toEqual(["btn"]);
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

describe("resolveAliases", () => {
  const tok = (name: string, value: string) => ({ name, value, family: tokenFamily(name), kind: tokenKind(value) });

  test("follows a bare reference to the value it names, and re-reads its kind", () => {
    const [accent, red] = resolveAliases([tok("--accent", "var(--red)"), tok("--red", "#ff4929")]);
    expect(accent?.resolved).toBe("#ff4929");
    expect(accent?.kind).toBe("color");
    // the authored value is kept: it is what you would go and edit
    expect(accent?.value).toBe("var(--red)");
    expect(red?.resolved).toBeUndefined();
  });

  test("fills in references sitting inside a larger value", () => {
    // the type scale is the case: a `font` shorthand names two other tokens
    const [type] = resolveAliases([
      tok("--type-mono", "400 var(--size-mono) var(--face-mono)"),
      tok("--size-mono", "12px"),
      tok("--face-mono", "ui-monospace, monospace"),
    ]);
    expect(type?.resolved).toBe("400 12px ui-monospace, monospace");
    expect(type?.kind).toBe("font");
  });

  test("follows a chain, and survives one that eats itself", () => {
    const chain = resolveAliases([tok("--a", "var(--b)"), tok("--b", "var(--c)"), tok("--c", "12px")]);
    expect(chain[0]?.resolved).toBe("12px");
    const cycle = resolveAliases([tok("--x", "var(--y)"), tok("--y", "var(--x)")]);
    expect(cycle[0]?.resolved).toBe("var(--x)");
  });

  test("leaves anything the cascade has to work out alone", () => {
    const [calc] = resolveAliases([tok("--w", "calc(var(--rail) - 1px)"), tok("--rail", "232px")]);
    expect(calc?.resolved).toBeUndefined();
  });
});
