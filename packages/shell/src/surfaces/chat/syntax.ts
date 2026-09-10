// Colouring code in the transcript. The diff pane runs Monaco's tokenizer over a whole file; the
// log gets hunks and fenced blocks, dozens of them down a scrolling column, and an editor per card
// is not a trade a browser survives. So the log tokenizes with highlight.js and both surfaces take
// their colours from the theme's own seven (syntaxOf), which is the half that has to match: the
// grain of the tokenizer is invisible at a glance, a keyword in the wrong green is not.

import type { Span } from "@toyon/shared";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";
import type { DiffLine } from "./toolCall.ts";

/** Registered one by one rather than by importing lowlight's `common`: the set is what a repo you
 * would open in toyon is written in, and every grammar past that is weight on the first paint of a
 * transcript. An unregistered language colours nothing, which is the right failure.
 *
 * The C-family grammars are not here; BY_EXT sends those extensions to javascript instead. It gets
 * their comments, strings, numbers and shared keywords right, if not `int` or `#include`, which is
 * most of what a glance down a transcript reads, and costs 27 KB less than carrying c, cpp, csharp,
 * java and swift. Ruby, php and sql have no such neighbour and are left to colour nothing. */
const low = createLowlight({
  bash,
  css,
  go,
  ini,
  javascript,
  json,
  markdown,
  python,
  rust,
  typescript,
  xml,
  yaml,
});

const BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  // the C family borrows javascript; the note on createLowlight above says why
  java: "javascript",
  kt: "javascript",
  c: "javascript",
  h: "javascript",
  cc: "javascript",
  cpp: "javascript",
  hpp: "javascript",
  cs: "javascript",
  swift: "javascript",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  env: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
};

/** what a fence or a file name says the block is written in, where we have a grammar for it. The
 * fence wins: an agent that wrote ```json over a .ts file's output meant the json. */
export function languageOf(fence: string, path: string): string | null {
  const named = fence && (BY_EXT[fence] ?? (low.registered(fence) ? fence : null));
  if (named) return named;
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  return (ext ? BY_EXT[ext] : null) ?? null;
}

const DIFF_HEADER = /^(?:diff --git a\/\S+ b\/(\S+)|\+\+\+ (?:b\/)?(\S+))$/gm;

/** the file a diff block is of, where it says so itself. An edit call names its file in the call,
 * but `git diff` in a run row carries its own headers, and that is the whole language a block of it
 * is written in. Only when it covers one file: two would mean colouring the second in the first
 * one's grammar, which is worse than leaving both plain. */
export function pathInDiff(text: string): string {
  const paths = new Set<string>();
  for (const m of text.matchAll(DIFF_HEADER)) {
    const path = m[1] ?? m[2] ?? "";
    if (path && path !== "/dev/null") paths.add(path);
  }
  // the same file names itself twice, in the `diff --git` line and again in the `+++`
  return paths.size === 1 ? ([...paths][0] as string) : "";
}

/** highlight.js scope -> one of the theme's seven. Its scopes are finer than a palette this size
 * can pay for, so the map is where the grain is given up on purpose: `built_in` and `class` are
 * both the type colour, a decorator is a keyword, an attribute is a variable. Anything unmapped
 * stays body text, which is what a token nobody has an opinion about should look like. */
const SCOPE: Record<string, string> = {
  comment: "comment",
  quote: "comment",
  doctag: "comment",
  keyword: "keyword",
  literal: "keyword",
  meta: "keyword",
  "meta-keyword": "keyword",
  operator: "keyword",
  "selector-tag": "keyword",
  tag: "keyword",
  string: "string",
  regexp: "string",
  "meta-string": "string",
  "template-tag": "string",
  symbol: "string",
  number: "number",
  type: "type",
  built_in: "type",
  class: "type",
  class_: "type",
  "selector-class": "type",
  "selector-id": "type",
  title: "function",
  function_: "function",
  function: "function",
  variable: "variable",
  language_: "variable",
  constant_: "variable",
  attr: "variable",
  attribute: "variable",
  property: "variable",
  params: "variable",
  name: "variable",
};

/** a run of one line that carries one scope */
export interface Tok {
  text: string;
  scope: string;
}

/** the scope of every character of `text`, one list per line. Newlines are cut here rather than at
 * the call site because a grammar's state runs across them: a template literal or a block comment
 * is one token that several lines share. */
export function tokenLines(text: string, language: string): Tok[][] {
  const lines: Tok[][] = [[]];
  const push = (value: string, scope: string) => {
    const parts = value.split("\n");
    for (const [i, part] of parts.entries()) {
      if (i > 0) lines.push([]);
      if (!part) continue;
      const line = lines[lines.length - 1] as Tok[];
      const last = line[line.length - 1];
      if (last && last.scope === scope) last.text += part;
      else line.push({ text: part, scope });
    }
  };
  const walk = (nodes: readonly Node[], scope: string) => {
    for (const node of nodes) {
      if (node.type === "text") push(node.value, scope);
      else if (node.type === "element") walk(node.children, scopeOf(node) ?? scope);
    }
  };
  try {
    walk(low.highlight(language, text).children as unknown as Node[], "");
  } catch {
    // a grammar that throws on the fragment (a hunk starting mid-expression is not a program) is
    // one block of plain text, not a broken transcript
    return text.split("\n").map((line) => (line ? [{ text: line, scope: "" }] : []));
  }
  return lines;
}

/** as much of hast as a colouring pass reads: lowlight emits text nodes and one span per scope */
type Node =
  | { type: "text"; value: string }
  | { type: "element"; properties?: { className?: string[] }; children: Node[] };

/** highlight.js writes its scope as `hljs-keyword`, and a compound one as two classes,
 * `hljs-title function_`. The more specific half is the second, so the last class we have a colour
 * for wins: `title function_` is a function, not a bare title. */
function scopeOf(node: Extract<Node, { type: "element" }>): string | null {
  const classes = node.properties?.className ?? [];
  let found: string | null = null;
  for (const cls of classes) {
    const mapped = SCOPE[cls.startsWith("hljs-") ? cls.slice(5) : cls];
    if (mapped) found = mapped;
  }
  return found;
}

/** what one line of a diff draws: the change spans say which characters the edit touched, the
 * tokens say what each character is. Both are runs over the same string, so this is one walk with
 * two cursors, and the pieces come out where either of them changes. */
export interface Piece {
  text: string;
  changed: boolean;
  scope: string;
}

/** a fenced block, coloured. Nothing changed in it, so its pieces carry the scope alone. */
export function paintCode(text: string, language: string | null): Piece[][] {
  if (!language) return [];
  return tokenLines(text, language).map((toks) => toks.map((t) => ({ text: t.text, changed: false, scope: t.scope })));
}

/** a diff block, coloured. The two sides are tokenized apart and stitched back together: a grammar
 * reading a hunk top to bottom would see every line twice, once as it was and once as it became,
 * and a deletion that opens a string it never closes would tint the rest of the block. Each hunk
 * is its own pass for the same reason, since the lines either side of a jump are not adjacent. */
export function paintDiff(lines: DiffLine[], language: string | null): Piece[][] {
  const toks: (Tok[] | undefined)[] = new Array(lines.length);
  if (language) {
    let start = 0;
    for (let i = 0; i <= lines.length; i++) {
      const kind = lines[i]?.kind;
      if (i < lines.length && kind !== "hunk" && kind !== "meta") continue;
      tokenizeHunk(lines, start, i, language, toks);
      start = i + 1;
    }
  }
  return lines.map((line, i) => pieces(line.spans, toks[i], line.text));
}

function tokenizeHunk(lines: DiffLine[], from: number, to: number, language: string, out: (Tok[] | undefined)[]): void {
  for (const side of ["del", "add"] as const) {
    const idx: number[] = [];
    for (let i = from; i < to; i++) {
      const kind = lines[i]?.kind;
      if (kind === "" || kind === side) idx.push(i);
    }
    if (idx.length === 0) continue;
    const text = idx.map((i) => lines[i]?.text ?? "").join("\n");
    const toks = tokenLines(text, language);
    // a context line goes in both passes, because each side has to read it to reach the state the
    // lines around it are in, but it takes its colours from the additions: that is the file as it
    // stands now, and a deleted line that opened a string it never closed is the deletion's problem
    for (const [k, i] of idx.entries()) if (side === "add" || lines[i]?.kind === "del") out[i] = toks[k];
  }
}

export function pieces(spans: Span[] | undefined, toks: Tok[] | undefined, text: string): Piece[] {
  if (!spans?.length && !toks?.length) return text ? [{ text, changed: false, scope: "" }] : [];
  const out: Piece[] = [];
  const change = spans?.length ? spans : [{ text, changed: false }];
  const token = toks?.length ? toks : [{ text, scope: "" }];
  let i = 0;
  let j = 0;
  let ci = 0;
  let ti = 0;
  while (i < change.length && j < token.length) {
    const a = change[i] as Span;
    const b = token[j] as Tok;
    const take = Math.min(a.text.length - ci, b.text.length - ti);
    if (take > 0) {
      const piece = { text: a.text.slice(ci, ci + take), changed: a.changed, scope: b.scope };
      const last = out[out.length - 1];
      if (last && last.changed === piece.changed && last.scope === piece.scope) last.text += piece.text;
      else out.push(piece);
    }
    ci += take;
    ti += take;
    if (ci >= a.text.length) {
      i++;
      ci = 0;
    }
    if (ti >= b.text.length) {
      j++;
      ti = 0;
    }
  }
  return out;
}
