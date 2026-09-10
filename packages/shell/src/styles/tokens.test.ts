import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { cssRules, shellCss } from "./cssRules.ts";

/**
 * Every custom property a stylesheet reads is declared somewhere, and every token tokens.css
 * declares is read somewhere. The ownership test holds this line for classes; this holds it for
 * `var(--x)`, which fails more quietly than a class does: a misspelled or renamed property does
 * not render as nothing, it renders as the fallback or as `unset`, which on a colour is usually
 * a colour close enough to pass a glance.
 *
 * A property may be declared in a stylesheet (a token, or a knob a component sets on its root
 * like --picker-bleed) or set from JS (the design pane's --design-column, the editors' reads of
 * --face-mono), so both count as declarations. The theme's colours are declared in tokens.css as
 * the no-JS fallback and overwritten by applyTheme, which is the one case of a declaration whose
 * value is not the one you see.
 */

const SRC = new URL("..", import.meta.url).pathname;

describe("custom properties", () => {
  test("every var() a stylesheet reads is declared, and every token declared is read", async () => {
    const code = (
      await Promise.all(
        [...new Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })]
          .filter((f) => !f.endsWith(".test.ts"))
          .map((f) => Bun.file(`${SRC}${f}`).text()),
      )
    ).join("\n");
    const setFromJs = new Set([...code.matchAll(/"(--[a-z][\w-]*)"/g)].map((m) => m[1]!));

    const declared = new Set<string>(setFromJs);
    const read = new Set<string>();
    for (const rule of cssRules(await shellCss())) {
      for (const [prop, value] of rule.decls) {
        if (prop.startsWith("--")) declared.add(prop);
        for (const m of value.matchAll(/var\((--[a-z][\w-]*)/g)) read.add(m[1]!);
      }
    }
    for (const m of code.matchAll(/var\((--[a-z][\w-]*)/g)) read.add(m[1]!);

    const tokens = [...(await Bun.file(`${SRC}styles/tokens.css`).text()).matchAll(/^\s*(--[a-z][\w-]*):/gm)].map(
      (m) => m[1]!,
    );

    const undeclared = [...read].filter((p) => !declared.has(p)).sort();
    const unread = tokens.filter((t) => !read.has(t) && !setFromJs.has(t)).sort();
    expect(undeclared).toEqual([]);
    expect(unread).toEqual([]);
  });
});
