import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { cssRules } from "./cssRules.ts";

/**
 * A class lives in the file of the component or surface that renders it, and nothing is defined
 * that nothing renders. This is the rule that the naming pass of 2026-09-10 established and the
 * one that decays fastest without a test: a class named for where a thing was first drawn is
 * exactly what a hurry produces, and the audit found six prefixes on one picker, three on one
 * status bar, and a Pane whose header wore "file" in the terminal.
 *
 * Two scopes. A stylesheet under styles/, ui/ or app/ is shared, so its classes may be rendered
 * anywhere in src (Button's tones are written by every surface; the row idiom by every list). A
 * stylesheet under surfaces/<s>/ is that surface's own, so every class it defines must be rendered
 * by a file in that directory; a class two surfaces both need is a base class, and this test is
 * what says so before a second copy appears. A surface file may still select a shared class (a
 * picker's rows inside the status bar's dropdown), which is why shared tokens are exempt there.
 *
 * The reverse holds too: a class a component writes must exist in some stylesheet, so a rename
 * that misses a site, or a class left behind by a rule that went, fails here rather than rendering
 * as nothing.
 */

const SRC = new URL("..", import.meta.url).pathname;

/** third-party DOM the shell reaches into; a selector naming one of these is theirs, not ours */
const FOREIGN = [".monaco-editor", ".xterm"];

/** classes built at runtime from a prefix, so no literal names them: the syntax scopes a theme
 * paints, `sy-${scope}` in ChatItemView */
const DYNAMIC_PREFIXES = ["sy-"];

const tokensOf = (selector: string): string[] => [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
const mentions = (text: string, cls: string) => new RegExp(`(?<![\\w-])${cls}(?![\\w-])`).test(text);

async function readAll(files: string[]): Promise<string> {
  return (await Promise.all(files.map((f) => Bun.file(`${SRC}${f}`).text()))).join("\n");
}

function scopeOf(cssFile: string): string | null {
  const m = cssFile.match(/^surfaces\/([^/]+)\//);
  return m ? `surfaces/${m[1]}/` : null;
}

describe("a class belongs to the file that renders it", () => {
  test("every class a stylesheet defines is rendered within its owner's scope", async () => {
    const cssFiles = [...new Glob("**/*.css").scanSync({ cwd: SRC })].sort();
    const codeFiles = [...new Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })].filter((f) => !f.endsWith(".test.ts"));
    const allCode = await readAll(codeFiles);

    const defined = new Map<string, Set<string>>();
    for (const f of cssFiles) {
      const set = new Set<string>();
      for (const rule of cssRules(await Bun.file(`${SRC}${f}`).text())) {
        for (const sel of rule.selectors) {
          if (FOREIGN.some((x) => sel.includes(x))) continue;
          for (const t of tokensOf(sel)) set.add(t);
        }
      }
      defined.set(f, set);
    }
    const shared = new Set<string>();
    for (const [f, set] of defined) if (!scopeOf(f)) for (const t of set) shared.add(t);

    const offenders: string[] = [];
    for (const [f, set] of defined) {
      const scope = scopeOf(f);
      const text = scope ? await readAll(codeFiles.filter((c) => c.startsWith(scope))) : allCode;
      for (const t of set) {
        if (scope && shared.has(t)) continue;
        if (DYNAMIC_PREFIXES.some((p) => t.startsWith(p) && allCode.includes(`${p}\${`))) continue;
        if (!mentions(text, t)) offenders.push(`${f} defines .${t}, which nothing in ${scope ?? "src"} renders`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  test("every class a component writes is defined in some stylesheet", async () => {
    const cssFiles = [...new Glob("**/*.css").scanSync({ cwd: SRC })];
    const defined = new Set<string>();
    for (const f of cssFiles) {
      for (const rule of cssRules(await Bun.file(`${SRC}${f}`).text())) {
        for (const sel of rule.selectors) for (const t of tokensOf(sel)) defined.add(t);
      }
    }
    const offenders: string[] = [];
    for (const f of new Glob("**/*.tsx").scanSync({ cwd: SRC })) {
      const src = await Bun.file(`${SRC}${f}`).text();
      // the static words of a className: a quoted string, the literal text of a template, and the
      // string branches of a template's ternaries (`${on ? "on" : ""}`); a string that is an
      // argument or a comparison inside the template is not a class
      for (const attr of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const raw = attr[1] ?? attr[2] ?? "";
        const literal = attr[1] !== undefined ? raw : raw.replace(/\$\{[^}]*\}/g, " ");
        const quoted = attr[1] !== undefined ? [] : [...raw.matchAll(/[?:]\s*"([a-z][\w-]*)"/g)].map((m) => m[1]!);
        for (const w of [...(literal.match(/[a-z][\w-]*/g) ?? []), ...quoted]) {
          if (!defined.has(w)) offenders.push(`${f} writes .${w}, which no stylesheet defines`);
        }
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });
});
