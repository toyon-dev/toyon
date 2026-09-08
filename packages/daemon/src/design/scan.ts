// Pure parsers behind DesignService: CSS declarations and selectors, component exports, imported
// identifiers, and string-literal prop unions. Nothing here touches the filesystem, so the service
// stays a thin shell around `git ls-files` and these.

import type { DesignToken, DesignTokenKind, DesignVariant } from "@toyon/shared";

const COLOR = /^(#|rgba?\(|hsla?\(|oklch\(|color\()/i;
const FONT_STACK = /(sans-serif|serif|monospace|system-ui|ui-monospace|cursive)/i;
const UNIT = /px|rem|em|%|ch|vh|vw|vmin|vmax|deg/;
const LENGTH = new RegExp(`^-?[\\d.]+(${UNIT.source}|s|ms)?$`);
/** a value computed from other values: `calc(var(--rail-w) - 1px)` */
const COMPUTED = /^(calc|var|clamp|min|max)\(/;

/** Decided from the value, not the name: a project can call a color anything, but `#6fae5f` is
 * only ever a color. Order matters, a shadow contains a color and a length both. */
export function tokenKind(value: string): DesignTokenKind {
  const v = value.trim();
  if (COLOR.test(v)) return "color";
  if (FONT_STACK.test(v)) return "font";
  // a computed value is whatever it computes to, and only the running page knows that. Reading a
  // unit out of it beats calling every `calc()` a shadow because it has spaces in it.
  if (COMPUTED.test(v)) return UNIT.test(v) ? "length" : "other";
  if (v.includes(",")) return "font";
  if (LENGTH.test(v)) return "length";
  if (v.split(/\s+/).length >= 3) return "shadow";
  return "other";
}

/** Comments carry filenames, and a filename has a dot in front of an identifier just like a class
 * selector does: without this, `see theme.ts` in a banner declares a class called `ts`. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, " ");

/** `--surface0` and `--surface1` are one family; `--r-xs` and `--r-pill` are another. The first
 * segment names it, and a trailing number is a rung within it rather than a family of its own. */
export function tokenFamily(name: string): string {
  const bare = name.replace(/^--/, "");
  const head = bare.split("-")[0] ?? bare;
  return head.replace(/\d+$/, "") || head;
}

/** Custom properties as a stylesheet declares them. The running page resolves `var()` chains and
 * theme overrides; this is the fallback for when the preview is down, so a value that is itself a
 * `var()` reference is kept verbatim rather than guessed at. */
export function cssTokens(css: string): DesignToken[] {
  const out = new Map<string, DesignToken>();
  for (const m of stripComments(css).matchAll(/(--[a-zA-Z][\w-]*)\s*:\s*([^;}]+)[;}]/g)) {
    const name = m[1]!;
    const value = m[2]!.trim();
    if (!value || out.has(name)) continue;
    out.set(name, { name, value, family: tokenFamily(name), kind: tokenKind(value) });
  }
  return [...out.values()];
}

/** Class names a stylesheet defines. Only selector preludes are read (the text before each `{`),
 * so a class-looking string inside a declaration value is not mistaken for one. */
export function cssClasses(css: string): string[] {
  const out = new Set<string>();
  for (const block of stripComments(css).matchAll(/([^{}]*)\{/g)) {
    const prelude = block[1]!.trim();
    if (!prelude || prelude.startsWith("@")) continue;
    for (const c of prelude.matchAll(/\.(-?[a-zA-Z][\w-]*)/g)) out.add(c[1]!);
  }
  return [...out];
}

/** Exported components, by the convention every framework shares: an exported binding whose name
 * starts with a capital. Cheap and wrong about the odd exported constant; the import count is what
 * separates a real component from one. */
export function exportedComponents(src: string): string[] {
  const out = new Set<string>();
  const add = (name: string | undefined) => {
    // SCREAMING_CASE is the other thing a capital letter means: a constant, not a component
    if (name && /^[A-Z]\w*$/.test(name) && !/^[A-Z0-9_]+$/.test(name)) out.add(name);
  };

  for (const m of src.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+(\w+)/g)) {
    add(m[1]);
  }
  // `export { Button, Menu as M }`. A trailing `from` makes it a re-export: the names belong to
  // the file it points at, and counting a barrel as their definition would move every component
  // in a project to its index file.
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*(from)?/g)) {
    if (m[2]) continue;
    for (const part of m[1]!.split(","))
      add(
        part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim(),
      );
  }
  // `export default Foo`, where Foo was declared above
  for (const m of src.matchAll(/export\s+default\s+(\w+)\s*;/g)) add(m[1]);

  return [...out];
}

/** Identifiers a file imports, default and named alike. Counting these per name across the repo is
 * what ranks components by use, and it is exact where grepping the bare name is not: a component's
 * own file mentions its name constantly without importing it. */
export function importedNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/import\s+([^;]*?)\s+from\s*["'][^"']+["']/g)) {
    const clause = m[1]!;
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const part of named[1]!.split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name && name !== "type") out.push(name.replace(/^type\s+/, ""));
      }
    }
    const first = clause
      .replace(/\{[^}]*\}/g, "")
      .replace(/^type\s+/, "")
      .split(",")[0]
      ?.trim();
    if (first && /^[A-Za-z_$][\w$]*$/.test(first)) out.push(first);
  }
  return out;
}

/**
 * Class names a source file applies, counted. Only the inside of a `class` / `className` attribute
 * is read. Counting bare occurrences of the name instead scores a class called `name` once for
 * every `name` variable in the project, which is how a stylesheet's most ordinary word outranks
 * its most used control.
 *
 * The expression form (`className={...}`) holds its names in string literals, so those are pulled
 * out and split; the plain attribute form is a class list already.
 */
export function appliedClasses(src: string): { classes: Map<string, number>; attrs: number } {
  const out = new Map<string, number>();
  let attrs = 0;
  for (const m of src.matchAll(ATTR)) {
    attrs++;
    const jsx = m[4];
    const quoted = m[2] ?? m[3];
    // A bound attribute holds code, not a class list: Vue's `:class`, Angular's `[ngClass]` and
    // JSX's `{...}` all name their classes in string literals or object keys, and everything else
    // in there is a variable. Splitting one on whitespace reports `isOn` as a class.
    const bound = m[1] !== undefined;
    const lists = jsx !== undefined || bound ? expressionClasses(jsx ?? quoted ?? "") : [stripHoles(quoted ?? "")];
    for (const list of lists) {
      for (const name of list.split(/\s+/)) {
        if (!/^-?[a-zA-Z][\w-]*$/.test(name)) continue;
        out.set(name, (out.get(name) ?? 0) + 1);
      }
    }
  }
  return { classes: out, attrs };
}

/** `class`, `className`, and the bound forms: `:class`, `v-bind:class`, `[class]`, `[ngClass]`. */
const ATTR =
  /(:|v-bind:|\[)?\b(?:ngClass|class(?:Name)?)\]?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\})/g;

/** A template hole is the host language's, not a class: `class="card {{ extra }}"` applies one
 * class, and reporting `extra` invents a second out of a variable name. */
const stripHoles = (s: string) => s.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|<%[\s\S]*?%>|\$\{[\s\S]*?\}/g, " ");

/** The class names inside an expression: string literals, plus object keys, which is how both
 * Vue's `:class="{ active: on }"` and clsx's `{ active: on }` name a conditional class. */
function expressionClasses(expression: string): string[] {
  const out = literals(expression);
  for (const m of expression.matchAll(/([a-zA-Z][\w-]*)\s*:/g)) out.push(m[1]!);
  return out;
}

/**
 * Every quoted run in an expression, one quote style at a time. Scanning for any-quote-to-any-quote
 * instead mispairs the moment a template holds one: in `` `btn ${on ? "on" : ""}` `` the opening
 * backtick would close against the first double quote, and the classes in the hole are lost. A
 * template captured whole keeps them, because the hole's own quotes survive into the split and are
 * rejected there, then found again by the pass for their own quote style.
 */
function literals(expression: string): string[] {
  const out: string[] = [];
  for (const quote of ['"', "'", "`"]) {
    for (const m of expression.matchAll(new RegExp(`${quote}([^${quote}]*)${quote}`, "g"))) out.push(m[1]!);
  }
  return out;
}

/** String-literal union props, parsed with the project's own TypeScript. `ts` is the module, taken
 * from the target repo rather than bundled: toyon would otherwise carry a compiler it only ever
 * uses as a parser. No program and no type checker, just `createSourceFile` and a walk, which is
 * why this survives across TypeScript versions. */
// biome-ignore lint/suspicious/noExplicitAny: the compiler module is loaded at runtime from the target repo, so it has no type here
export function propUnions(ts: any, path: string, src: string): DesignVariant[] {
  const file = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true);
  const out: DesignVariant[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: AST nodes come from the untyped runtime module above
  const visit = (node: any) => {
    const members = node.members;
    if (members && (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node))) {
      // biome-ignore lint/suspicious/noExplicitAny: same
      for (const member of members as any[]) {
        if (!ts.isPropertySignature(member) || !member.type || !member.name) continue;
        const values = unionLiterals(ts, member.type);
        if (values.length >= 2) out.push({ prop: member.name.getText(file), values, unused: [] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: as above
function unionLiterals(ts: any, type: any): string[] {
  if (!ts.isUnionTypeNode(type)) return [];
  const values: string[] = [];
  for (const part of type.types) {
    // an optional prop unions with `undefined`, which is not one of the choices
    if (part.kind === ts.SyntaxKind.UndefinedKeyword) continue;
    if (!ts.isLiteralTypeNode(part) || !ts.isStringLiteral(part.literal)) return [];
    values.push(part.literal.text);
  }
  return values;
}
