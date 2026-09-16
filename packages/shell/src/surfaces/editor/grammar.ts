// Colouring a file in the editor pane with the TextMate grammars VS Code uses, in place of Monaco's
// own monarch tokenizers. A monarch grammar is a regex lexer with no idea of structure: it has no
// token for a call, reads JSX as TypeScript (`in` and `for` in a paragraph came out as keywords,
// any capitalised word of it as a type) and cannot tell a tag's attribute from a variable. The
// TextMate grammars know all three. Their scopes are then folded onto the token names the theme
// already colours, so a theme still names seven colours and nothing here knows what they are.

import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import css from "@shikijs/langs/css";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import scss from "@shikijs/langs/scss";
import shellscript from "@shikijs/langs/shellscript";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";
import type * as monaco from "monaco-editor";

/** Monaco language id -> the grammar that reads it. `typescript` and `typescriptreact` are two
 * grammars because the two languages disagree about `<T>(x) => x`: a .ts file's generic arrow is a
 * JSX tag to the tsx grammar, and everything after it goes wrong. JavaScript has no generics, so
 * the jsx grammar reads every .js file. JSON is left to Monaco: its tokenizer is the json worker's
 * own scanner, which already knows a key from a value, and it replaces any other when it loads. */
export const GRAMMAR: Record<string, string> = {
  typescript: "typescript",
  typescriptreact: "tsx",
  javascript: "jsx",
  css: "css",
  scss: "scss",
  html: "html",
  markdown: "markdown",
  python: "python",
  go: "go",
  rust: "rust",
  yaml: "yaml",
  shell: "shellscript",
};

/** TextMate scope -> a token name monacoTheme has a rule for. A scope matches its longest dotted
 * prefix listed here, so `entity.name.function.tsx` is `entity.name.function`. An empty name is
 * body text, and it stops the walk outward: JSX text sits inside a tag inside a function, and none
 * of those is a colour for the words. The grain given up is the same the transcript gives up:
 * a component tag is a type, a decorator a keyword, an attribute or an object key a variable, and
 * a plain variable or a parameter is body text, because nearly every word of code is one. */
const SCOPE: Record<string, string> = {
  comment: "comment",
  "punctuation.definition.comment": "comment",
  string: "string",
  "punctuation.definition.string": "string",
  "string.regexp": "regexp",
  "constant.character.escape": "string.escape",
  "constant.character.entity": "string.escape",
  "punctuation.definition.entity": "string.escape",
  "constant.numeric": "number",
  "keyword.other.unit": "number",
  "constant.language": "constant",
  "constant.other": "constant",
  "support.constant": "constant",
  keyword: "keyword",
  storage: "keyword",
  "variable.language": "keyword",
  "entity.name.function.decorator": "keyword",
  "markup.heading": "keyword",
  "entity.name.section": "keyword",
  "keyword.operator": "operator",
  "keyword.operator.new": "keyword",
  "keyword.operator.expression": "keyword",
  "storage.type.function.arrow": "operator",
  "entity.name.function": "function",
  "support.function": "function",
  "meta.function-call.generic": "function",
  "entity.name.type": "type",
  "entity.name.class": "type",
  "entity.name.namespace": "type",
  "entity.other.inherited-class": "type",
  "support.type": "type",
  "support.class": "type",
  "entity.other.attribute-name.class": "type",
  "entity.other.attribute-name.id": "type",
  "support.type.property-name": "key",
  "meta.object-literal.key": "key",
  "entity.name.tag.yaml": "key",
  "entity.name.tag": "tag",
  "support.class.component": "type",
  "entity.other.attribute-name": "attribute.name",
  punctuation: "delimiter",
  "meta.brace": "delimiter",
  "punctuation.definition.tag": "delimiter",
  variable: "identifier",
  "meta.jsx.children": "",
  "meta.embedded": "",
  "meta.template.expression": "",
  "markup.bold": "strong",
  "markup.italic": "emphasis",
  "markup.inline.raw": "string",
  "markup.fenced_code": "string",
  "markup.underline.link": "string",
  "markup.quote": "comment",
  invalid: "invalid",
};

/** the theme token for one token's scopes, outermost first as a grammar lists them */
export function tokenOf(scopes: readonly string[]): string {
  for (let i = scopes.length - 1; i >= 0; i--) {
    let scope = scopes[i] as string;
    for (;;) {
      const named = SCOPE[scope];
      if (named !== undefined) return named;
      const dot = scope.lastIndexOf(".");
      if (dot < 0) break;
      scope = scope.slice(0, dot);
    }
  }
  return "";
}

let highlighter: HighlighterCore | null = null;

/** Oniguruma, the engine VS Code runs these grammars on, rather than Shiki's JavaScript one: in
 * Chromium the JavaScript engine took 412ms to colour a 470-line .tsx file the first time and 74ms
 * after, against 161ms and 17ms here, and the first pass is a freeze on the file someone just
 * opened. Its wasm has to load before any file is coloured, so the pane waits on this. */
export const grammarsReady: Promise<void> = createHighlighterCore({
  themes: [],
  langs: [typescript, tsx, jsx, css, scss, html, markdown, python, go, rust, yaml, shellscript],
  engine: createOnigurumaEngine(import("@shikijs/engine-oniguruma/wasm-inlined")),
}).then((h) => {
  highlighter = h;
});

type RuleStack = Parameters<ReturnType<HighlighterCore["getLanguage"]>["tokenizeLine"]>[1];

/** A line's end state, as Monaco carries it to the next line. The grammar never mutates a rule
 * stack, so cloning is handing it on. Equality is what lets Monaco stop re-reading the lines below
 * an edit once a line ends where it ended before. */
class LineState implements monaco.languages.IState {
  constructor(readonly stack: RuleStack) {}
  clone() {
    return this;
  }
  equals(other: monaco.languages.IState) {
    if (!(other instanceof LineState)) return false;
    if (!this.stack || !other.stack) return this.stack === other.stack;
    return this.stack.equals(other.stack);
  }
}

/** a line past this is minified or data, and one grammar pass over it can hold the main thread */
const LONG_LINE = 20_000;
/** a pass over one line that takes longer than this is cut short and the rest of it left plain */
const LINE_BUDGET_MS = 500;

/** Registered directly, a provider outranks the monarch tokenizer Monaco loads for the language
 * when a file of it first opens, so ours is the one that paints. It is also synchronous once
 * `grammarsReady` has settled, which the pane's first-frame colouring relies on. */
export function registerGrammars(m: typeof monaco) {
  for (const language of Object.keys(GRAMMAR)) {
    m.languages.setTokensProvider(language, {
      getInitialState: initialState,
      tokenize: (line, state) => tokenizeLine(language, line, state),
    });
  }
}

export const initialState = (): monaco.languages.IState => new LineState(null);

/** one line of a file in `language` coloured, carrying on from where the line above it ended */
export function tokenizeLine(language: string, line: string, state: monaco.languages.IState) {
  const start = state as LineState;
  if (!highlighter || line.length > LONG_LINE) return { tokens: [{ startIndex: 0, scopes: "" }], endState: start };
  const r = highlighter.getLanguage(GRAMMAR[language] as string).tokenizeLine(line, start.stack, LINE_BUDGET_MS);
  return {
    tokens: r.tokens.map((t) => ({ startIndex: t.startIndex, scopes: tokenOf(t.scopes) })),
    endState: new LineState(r.ruleStack),
  };
}
