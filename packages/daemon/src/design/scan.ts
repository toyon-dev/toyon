// Pure parsers behind DesignService: CSS declarations and selectors, component exports, imported
// identifiers, and string-literal prop unions. Nothing here touches the filesystem, so the service
// stays a thin shell around `git ls-files` and these.

import type { DesignLiteral, DesignLiteralRole, DesignToken, DesignTokenKind, DesignVariant } from "@toyon/shared";

// color-mix and light-dark before the comma rule below, or a `color-mix(in srgb, …)` is filed as a
// font stack on the strength of its commas and shown as a type specimen
const COLOR = /^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\(|color-mix\(|light-dark\()/i;
const FONT_STACK = /(sans-serif|serif|monospace|system-ui|ui-monospace|cursive)/i;
const UNIT = /px|rem|em|%|ch|vh|vw|vmin|vmax|deg/;
const LENGTH = new RegExp(`^-?[\\d.]+(${UNIT.source}|s|ms)?$`);
/** a value computed from other values: `calc(var(--rail-w) - 1px)` */
const COMPUTED = /^(calc|var|clamp|min|max)\(/;
/** a `font` shorthand: a weight, then a size. Checked before the shadow rule, which otherwise
 * claims it on word count alone: `400 13px / 1.5 var(--face-ui)` and `0 2px 6px #0006` are both
 * three or more parts, and only one of them is a shadow. A shadow never opens with 100..900. The
 * size may itself be a var(), as it is wherever an editor has to parseFloat it back out. */
const FONT_SHORTHAND = /^[1-9]00\s+([\d.]|var\()/;

/** Decided from the value, not the name: a project can call a color anything, but `#6fae5f` is
 * only ever a color. Order matters, a shadow contains a color and a length both. */
export function tokenKind(value: string): DesignTokenKind {
  const v = value.trim();
  if (COLOR.test(v)) return "color";
  if (FONT_STACK.test(v) || FONT_SHORTHAND.test(v)) return "font";
  // a computed value is whatever it computes to, and only the running page knows that. Reading a
  // unit out of it beats calling every `calc()` a shadow because it has spaces in it.
  if (COMPUTED.test(v)) return UNIT.test(v) ? "length" : "other";
  // a shadow whose colour is rgba() or hsl() has commas in it, and the comma rule below would
  // file it as a font stack: same trap color-mix fell into. A font stack opens with a family name,
  // a shadow with an offset, so the first part decides it.
  const parts = v.split(/\s+/);
  if (parts.length >= 3 && LENGTH.test(parts[0] ?? "")) return "shadow";
  if (v.includes(",")) return "font";
  if (LENGTH.test(v)) return "length";
  if (parts.length >= 3) return "shadow";
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
export function appliedClasses(src: string): {
  classes: Map<string, number>;
  attrs: number;
  /** classes seen as the only one on an element. A class that never appears alone is a modifier of
   * whatever it rides with (`btn btn-outline`, `row on`), not a thing in its own right, and asking
   * why no component is named for it is asking the wrong question. */
  solo: Set<string>;
} {
  const out = new Map<string, number>();
  const solo = new Set<string>();
  const modules = moduleImports(src);
  let attrs = 0;
  for (const m of src.matchAll(ATTR)) {
    attrs++;
    const jsx = m[4];
    const quoted = m[2] ?? m[3];
    // A bound attribute holds code, not a class list: Vue's `:class`, Angular's `[ngClass]` and
    // JSX's `{...}` all name their classes in string literals or object keys, and everything else
    // in there is a variable. Splitting one on whitespace reports `isOn` as a class.
    const bound = m[1] !== undefined;
    const lists =
      jsx !== undefined || bound ? expressionClasses(jsx ?? quoted ?? "", modules) : [stripHoles(quoted ?? "")];
    const onThisElement: string[] = [];
    for (const list of lists) {
      for (const name of list.split(/\s+/)) {
        if (!/^-?[a-zA-Z][\w-]*$/.test(name)) continue;
        out.set(name, (out.get(name) ?? 0) + 1);
        onThisElement.push(name);
      }
    }
    if (onThisElement.length === 1) solo.add(onThisElement[0]!);
  }
  return { classes: out, attrs, solo };
}

/** `class`, `className`, and the bound forms: `:class`, `v-bind:class`, `[class]`, `[ngClass]`. */
const ATTR =
  /(:|v-bind:|\[)?\b(?:ngClass|class(?:Name)?)\]?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\})/g;

/** A template hole is the host language's, not a class: `class="card {{ extra }}"` applies one
 * class, and reporting `extra` invents a second out of a variable name. */
const stripHoles = (s: string) => s.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|<%[\s\S]*?%>|\$\{[\s\S]*?\}/g, " ");

/**
 * The class names inside an expression: string literals, object keys, and CSS Modules lookups.
 *
 * An object key has to be the start of an entry, so only one that follows `{` or `,` counts. Taking
 * every identifier before a colon reads the colon of a ternary as an object key, and
 * `{a ? styles.primary : styles.base}` then reports a class called `primary` that the element only
 * wears half the time and that nothing in the file spells that way.
 */
function expressionClasses(expression: string, modules: Set<string>): string[] {
  const out = literals(expression);
  for (const m of expression.matchAll(/[{,]\s*([a-zA-Z][\w-]*)\s*:/g)) out.push(m[1]!);
  for (const local of modules) {
    const esc = local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Only the dot form: `styles["btn-wide"]` is a quoted string, so the literals pass above
    // already has it.
    for (const m of expression.matchAll(new RegExp(`\\b${esc}\\.([A-Za-z_]\\w*)`, "g"))) out.push(m[1]!);
  }
  return out;
}

/**
 * Local names bound to a CSS Modules stylesheet: `import styles from "./Button.module.css"`.
 *
 * Without this a CSS Modules project reports every class as unused, because the class never appears
 * as text anywhere: the build rewrites `.btn` to `.Button_btn__x7Fq2` and the source only ever says
 * `styles.btn`.
 */
export function moduleImports(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(
    /import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s+from\s*["'][^"']*\.module\.(?:css|scss|sass|less)["']/g,
  )) {
    out.add(m[1]!);
  }
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

/**
 * Follow `--accent: var(--red)` to the value it actually names, including references sitting inside
 * a larger value: `400 var(--size-mono) var(--face-mono)` resolves to `400 12px ui-monospace, ...`.
 *
 * Arithmetic is still left alone entirely: a `calc()` needs the cascade and a layout, and half of
 * it filled in is not an answer either. The shell cannot do any of this itself: a `var(--red)`
 * evaluated in the shell's document resolves against the *shell's* red and paints a confident lie.
 */
export function resolveAliases(tokens: DesignToken[]): DesignToken[] {
  const byName = new Map(tokens.map((t) => [t.name, t]));
  // a reference, with or without a fallback. A nested var() in the fallback is left alone: the
  // fallback only applies when the reference misses, and a miss is not something to flatten.
  const REF = /var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)/g;
  const ARITHMETIC = /^(calc|clamp|min|max)\(/;

  const expand = (value: string, seen: ReadonlySet<string>, hop: number): string =>
    hop > 8
      ? value
      : value.replace(REF, (whole, name: string) => {
          // a cycle would otherwise spin here; a token that points at itself has no value to find
          if (seen.has(name)) return whole;
          const target = byName.get(name);
          return target ? expand(target.value, new Set([...seen, name]), hop + 1) : whole;
        });

  return tokens.map((t) => {
    if (ARITHMETIC.test(t.value.trim())) return t;
    const value = expand(t.value, new Set([t.name]), 0);
    if (value === t.value) return t;
    return { ...t, resolved: value, kind: tokenKind(value) };
  });
}

/** One style rule: the selector it applies to, with nesting and at-rules flattened away. */
export interface CssRule {
  selector: string;
  decls: Array<[prop: string, value: string]>;
}

/** Blocks whose declarations describe something other than an element. A `font-family` inside
 * `@font-face` names a font rather than using one, and a keyframe's `from` is not a selector. */
const DESCRIPTOR_BLOCK = /^@(?:-webkit-)?(?:font-face|keyframes|property|counter-style|page|font-feature-values)\b/i;

/** `//` comments, which Sass, Less and Stylus allow and CSS does not. The character in front rules
 * out a URL (`https://`, `url(//cdn)`), where the two slashes are not a comment. */
const stripLineComments = (css: string) => css.replace(/(^|[^:(\w"'])\/\/[^\n]*/g, "$1");

/**
 * Every style rule a stylesheet writes, each with the selector a nested rule actually applies to.
 *
 * A walk rather than a regex, because what is read here is which rule a declaration sits in: the
 * font a whole page inherits and the `font-size` on one heading are the same text otherwise.
 * Semicolons and braces inside parentheses or quotes belong to a value
 * (`url(data:image/png;base64,...)`), so those are stepped over.
 */
export function cssRules(css: string): CssRule[] {
  const text = stripLineComments(stripComments(css));
  const out: CssRule[] = [];
  const stack: Array<{ rule: CssRule | null; selector: string | null; skip: boolean }> = [
    { rule: null, selector: null, skip: false },
  ];
  const top = () => stack[stack.length - 1]!;
  let buf = "";
  let depth = 0;
  let quote = "";

  const declare = () => {
    const m = /^([a-zA-Z-][\w-]*)\s*:\s*([\s\S]+)$/.exec(buf.trim());
    const { rule, skip } = top();
    if (m && rule && !skip) rule.decls.push([m[1]!.toLowerCase(), m[2]!.trim()]);
    buf = "";
  };
  const open = () => {
    const prelude = buf.trim().replace(/\s+/g, " ");
    buf = "";
    const parent = top();
    if (parent.skip || DESCRIPTOR_BLOCK.test(prelude)) {
      stack.push({ rule: null, selector: null, skip: true });
    } else if (!prelude || prelude.startsWith("@")) {
      // @media, @supports, @layer and @container wrap rules without being one, so a declaration
      // directly inside one still belongs to the rule around it
      stack.push({ ...parent });
    } else {
      const outer = parent.selector;
      const selector =
        outer === null ? prelude : prelude.includes("&") ? prelude.replace(/&/g, () => outer) : `${outer} ${prelude}`;
      const rule: CssRule = { selector, decls: [] };
      out.push(rule);
      stack.push({ rule, selector, skip: false });
    }
  };

  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && ch === ";") {
      declare();
      continue;
    } else if (depth === 0 && ch === "{") {
      open();
      continue;
    } else if (depth === 0 && ch === "}") {
      declare();
      if (stack.length > 1) stack.pop();
      continue;
    }
    buf += ch;
  }
  return out;
}

/** the face and leading type inherits, where a rule sets them */
export interface FontContext {
  family?: string;
  lead?: string;
}

const FONT_LENGTH = /^[\d.]+(?:px|rem|em|pt|%)$/;
const LEAD = /^(?:[\d.]+(?:px|rem|em|%)?|normal)$/;
const WIDE_KEYWORD = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
/** `font: italic 600 13px/1.5 Inter, sans-serif`: the size is the first length, an optional
 * `/leading` follows it, and the family list runs from there to the end */
const FONT_PARTS = /(?:^|\s)([\d.]+(?:px|rem|em|pt|%))(?:\s*\/\s*(\S+))?\s+(\S[\s\S]*)$/;

function fontParts(value: string): { size: string; lead?: string; family: string } | null {
  const m = FONT_PARTS.exec(value);
  return m ? { size: m[1]!, lead: m[2], family: m[3]!.trim() } : null;
}

/** a family worth naming: `var(--face)` is a token's, and `inherit` is nobody's */
const literalFamily = (v: string | undefined) => (v && !WIDE_KEYWORD.test(v) && !v.includes("var(") ? v : undefined);

/** a rule's own face and leading, later declarations winning the way the cascade reads a rule */
function ruleFont(rule: CssRule): FontContext {
  const out: FontContext = {};
  for (const [prop, value] of rule.decls) {
    if (prop === "font-family") out.family = literalFamily(value) ?? out.family;
    else if (prop === "line-height" && LEAD.test(value)) out.lead = value;
    else if (prop === "font") {
      const parts = fontParts(value);
      out.family = literalFamily(parts?.family) ?? out.family;
      out.lead = parts?.lead ?? out.lead;
    }
  }
  return out;
}

const ROOT_SELECTOR = /^(?:html|body|:root|\*)$/;
const isRoot = (selector: string) => selector.split(",").every((s) => ROOT_SELECTOR.test(s.trim()));

/** How close a root rule sits to the text: `*` sets every element directly and beats inheritance,
 * body is what the text inherits from, and html and :root are one step further out. */
const rootRank = (selector: string) => (selector.includes("*") ? 3 : /\bbody\b/.test(selector) ? 2 : 1);

/** The face and leading a size inherits when its own rule names neither: whatever the page root
 * sets, the root closest to the text winning. */
export function rootFont(rules: CssRule[]): FontContext {
  const out: FontContext = {};
  const rank = { family: 0, lead: 0 };
  for (const rule of rules) {
    if (!isRoot(rule.selector)) continue;
    const font = ruleFont(rule);
    const r = rootRank(rule.selector);
    if (font.family && r > rank.family) [out.family, rank.family] = [font.family, r];
    if (font.lead && r > rank.lead) [out.lead, rank.lead] = [font.lead, r];
  }
  return out;
}

/** one declaration's worth of a written-out value, before the stylesheets are folded together */
export interface LiteralHit {
  role: DesignLiteralRole;
  value: string;
  selector: string;
  family?: string;
  lead?: string;
  ground?: boolean;
}

/** a colour written as itself. Only spellings that cannot be anything else: a named colour is also
 * a word, and `transparent` or `currentColor` are not palette entries. */
const HEX_LITERAL = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;
const COLOR_FN_LITERAL = /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^()]*\)/gi;
const RADIUS_PROP = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/;
const RADIUS_VALUE = /^[\d.]+(?:px|rem|em|%)?(?:\s+[\d.]+(?:px|rem|em|%)?){0,3}$/;

function colorsIn(value: string): string[] {
  // a url() holds fragment ids (`url(#grad)`) and a string holds anything; neither is a colour
  const bare = value.replace(/url\([^)]*\)/gi, " ").replace(/"[^"]*"|'[^']*'/g, " ");
  return [...bare.matchAll(HEX_LITERAL), ...bare.matchAll(COLOR_FN_LITERAL)].map((m) => m[0]);
}

/**
 * The colours, faces, sizes, radii and shadows a stylesheet writes out in place. A reference to a
 * variable is skipped wherever it sits: that value has a name, and the tokens already show it.
 *
 * A shadow's colour is not taken as a palette entry. It is nearly always black at some alpha, and
 * a row of those beside the brand colours buries them.
 */
export function cssLiterals(rules: CssRule[], root: FontContext): LiteralHit[] {
  const out: LiteralHit[] = [];
  for (const rule of rules) {
    const own = ruleFont(rule);
    const add = (hit: Omit<LiteralHit, "selector">) => out.push({ ...hit, selector: rule.selector });
    const size = (value: string) =>
      add({ role: "size", value, family: own.family ?? root.family, lead: own.lead ?? root.lead });
    for (const [prop, value] of rule.decls) {
      if (prop.startsWith("--")) continue;
      if (prop === "box-shadow" || prop === "text-shadow") {
        if (!/^none$/i.test(value) && !value.includes("var(")) add({ role: "shadow", value });
        continue;
      }
      if (prop !== "filter" && prop !== "backdrop-filter") {
        const ground = isRoot(rule.selector) && /^background(?:-color)?$/.test(prop);
        for (const color of colorsIn(value)) add({ role: "color", value: color, ground });
      }
      if (prop === "font-family" && literalFamily(value)) add({ role: "family", value });
      if (prop === "font") {
        const parts = fontParts(value);
        if (parts && literalFamily(parts.family)) add({ role: "family", value: parts.family });
        if (parts) size(parts.size);
      }
      if (prop === "font-size" && FONT_LENGTH.test(value)) size(value);
      // a zero radius is a reset, not a rung on the scale
      if (RADIUS_PROP.test(prop) && RADIUS_VALUE.test(value) && /[1-9]/.test(value)) add({ role: "radius", value });
    }
  }
  return out;
}

/** How two spellings of one value are told from two values: `#FFF` and `#ffffff` are one colour,
 * and `'Inter', sans-serif` and `"Inter",sans-serif` are one stack. */
export function literalKey(role: DesignLiteralRole, value: string): string {
  const v = value.trim().toLowerCase();
  if (role === "color") {
    const short = /^#([0-9a-f]{3,4})$/.exec(v);
    return short ? `#${[...short[1]!].map((c) => c + c).join("")}` : v.replace(/\s+/g, "");
  }
  if (role === "family") return v.replace(/'/g, '"').replace(/\s*,\s*/g, ",");
  return v.replace(/\s+/g, " ");
}

/** enough to say where a value lives without shipping every rule of a large stylesheet */
const MAX_SELECTORS = 6;

/** Every stylesheet's hits folded into one entry per value, in the order the files are given. */
export function mergeLiterals(files: Array<{ path: string; hits: LiteralHit[] }>): DesignLiteral[] {
  // one stack spelled two ways is one face, so a size names its face the way the family entry does
  const faces = new Map<string, string>();
  for (const { hits } of files) {
    for (const hit of hits) {
      const key = literalKey("family", hit.value);
      if (hit.role === "family" && !faces.has(key)) faces.set(key, hit.value);
    }
  }

  const out = new Map<string, DesignLiteral>();
  for (const { path, hits } of files) {
    for (const hit of hits) {
      const family = hit.family === undefined ? undefined : (faces.get(literalKey("family", hit.family)) ?? hit.family);
      const key = [
        hit.role,
        literalKey(hit.role, hit.value),
        family ? literalKey("family", family) : "",
        hit.lead ?? "",
      ];
      const id = key.join("\n");
      const seen = out.get(id);
      if (seen) {
        seen.uses++;
        if (seen.selectors.length < MAX_SELECTORS && !seen.selectors.includes(hit.selector)) {
          seen.selectors.push(hit.selector);
        }
        if (hit.ground) seen.ground = true;
        continue;
      }
      const literal: DesignLiteral = { value: hit.value, role: hit.role, uses: 1, selectors: [hit.selector], path };
      if (family !== undefined) literal.family = family;
      if (hit.lead !== undefined) literal.lead = hit.lead;
      if (hit.ground) literal.ground = true;
      out.set(id, literal);
    }
  }
  return [...out.values()];
}
