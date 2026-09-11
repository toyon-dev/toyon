// The pages a React Router app declares in code: <Route> elements, and route objects handed to
// createBrowserRouter, createHashRouter or useRoutes. A small lexer and a reader over what it
// produces, with no parser dependency: only literal routes can be listed, and finding those takes no
// more than this.
//
// Out of reach on purpose: a path that is not a literal, routes built by map or in a function,
// children more than one import away or inside a lazy module, a wrapper component that takes `path`,
// and framework mode's app/routes.ts (which reads as Remix).

import { posix } from "node:path";

export interface SourceFile {
  /** relative to the app's root */
  path: string;
  text: string;
}

export interface CodeRoute {
  path: string;
  /** the module the route renders, else the file that declares it */
  file: string;
  dynamic: boolean;
  endpoint: boolean;
}

/** a file worth reading: it names something only a route table would */
export const ROUTER_MARKER =
  /<Route\b|createBrowserRouter|createHashRouter|createRoutesFromElements|useRoutes|RouteObject/;

// ---- lexer ----

type Tok =
  | { k: "id"; v: string }
  | { k: "str"; v: string }
  | { k: "tpl" }
  | { k: "p"; v: string }
  | { k: "jsx"; node: JsxNode };

interface JsxNode {
  name: string;
  attrs: Map<string, Attr>;
  children: Child[];
}
type Attr = { k: "str"; v: string } | { k: "expr"; toks: Tok[] } | { k: "bare" };
type Child = { k: "node"; node: JsxNode } | { k: "expr"; toks: Tok[] };

/** words after which a `<` or a `/` starts a value, not a comparison or a division */
const BEFORE_VALUE = new Set([
  "return",
  "case",
  "default",
  "yield",
  "await",
  "typeof",
  "void",
  "in",
  "of",
  "new",
  "throw",
  "else",
  "do",
]);
const PUNCT = ["...", "=>", "&&", "||", "??", "?."];
const ID = /[A-Za-z_$][\w$]*/y;
const NUM = /[\w.]+/y;
const TAG = /[\w$.:-]+/y;
const ATTR = /[\w$:-]+/y;

class Lexer {
  i = 0;
  constructor(
    private s: string,
    /** a .ts file has no JSX, and `<T>value` there is a type assertion */
    private jsx: boolean,
  ) {}

  /** tokens to the end, or, when `closing`, to the brace that closes the one just stepped over */
  run(closing = false): Tok[] {
    const out: Tok[] = [];
    const s = this.s;
    let depth = 0;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === " " || c === "\n" || c === "\t" || c === "\r") {
        this.i++;
      } else if (c === "/" && s[this.i + 1] === "/") {
        const end = s.indexOf("\n", this.i);
        this.i = end < 0 ? s.length : end;
      } else if (c === "/" && s[this.i + 1] === "*") {
        const end = s.indexOf("*/", this.i + 2);
        this.i = end < 0 ? s.length : end + 2;
      } else if (c === '"' || c === "'") {
        out.push({ k: "str", v: this.string(c) });
      } else if (c === "`") {
        out.push(this.template());
      } else if (/[A-Za-z_$]/.test(c)) {
        out.push({ k: "id", v: this.match(ID) ?? c });
      } else if (/[0-9]/.test(c)) {
        this.match(NUM);
        out.push({ k: "p", v: "0" });
      } else if (c === "<" && this.jsx && this.valueNext(out) && /[A-Za-z>]/.test(s[this.i + 1] ?? "")) {
        out.push({ k: "jsx", node: this.element() });
      } else if (c === "/" && this.valueNext(out)) {
        this.regex();
        out.push({ k: "p", v: "0" });
      } else {
        if (c === "{") depth++;
        if (c === "}") {
          if (closing && depth === 0) {
            this.i++;
            return out;
          }
          depth--;
        }
        const p = PUNCT.find((x) => s.startsWith(x, this.i)) ?? c;
        this.i += p.length;
        out.push({ k: "p", v: p });
      }
    }
    return out;
  }

  private match(re: RegExp): string | null {
    re.lastIndex = this.i;
    const m = re.exec(this.s);
    if (!m || m[0] === "") return null;
    this.i += m[0].length;
    return m[0];
  }

  /** what came before starts a value here, so `<` opens an element and `/` a regex */
  private valueNext(out: Tok[]): boolean {
    const t = out[out.length - 1];
    if (!t) return true;
    if (t.k === "id") return BEFORE_VALUE.has(t.v);
    if (t.k !== "p") return false;
    return !(t.v === ")" || t.v === "]" || t.v === "}" || t.v === "0");
  }

  private string(quote: string): string {
    const s = this.s;
    let v = "";
    this.i++;
    while (this.i < s.length && s[this.i] !== quote && s[this.i] !== "\n") {
      if (s[this.i] === "\\") {
        v += s[this.i + 1] ?? "";
        this.i += 2;
      } else v += s[this.i++];
    }
    this.i++;
    return v;
  }

  private template(): Tok {
    const s = this.s;
    let v = "";
    let literal = true;
    this.i++;
    while (this.i < s.length && s[this.i] !== "`") {
      if (s[this.i] === "\\") {
        v += s[this.i + 1] ?? "";
        this.i += 2;
      } else if (s.startsWith("${", this.i)) {
        literal = false;
        this.i += 2;
        this.run(true);
      } else v += s[this.i++];
    }
    this.i++;
    return literal ? { k: "str", v } : { k: "tpl" };
  }

  private regex(): void {
    const s = this.s;
    let inClass = false;
    this.i++;
    while (this.i < s.length && s[this.i] !== "\n") {
      const c = s[this.i]!;
      if (c === "\\") this.i++;
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        this.i++;
        break;
      }
      this.i++;
    }
    this.match(ID);
  }

  private skipSpace(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  private element(): JsxNode {
    const s = this.s;
    this.i++;
    const node: JsxNode = { name: this.match(TAG) ?? "", attrs: new Map(), children: [] };
    while (this.i < s.length) {
      this.skipSpace();
      if (s.startsWith("/>", this.i)) {
        this.i += 2;
        return node;
      }
      if (s[this.i] === ">") {
        this.i++;
        break;
      }
      if (s[this.i] === "{") {
        // {...props}
        this.i++;
        this.run(true);
        continue;
      }
      const name = this.match(ATTR);
      if (!name) {
        this.i++;
        continue;
      }
      this.skipSpace();
      if (s[this.i] !== "=") {
        node.attrs.set(name, { k: "bare" });
        continue;
      }
      this.i++;
      this.skipSpace();
      const c = s[this.i];
      if (c === '"' || c === "'") node.attrs.set(name, { k: "str", v: this.string(c) });
      else if (c === "{") {
        this.i++;
        node.attrs.set(name, { k: "expr", toks: this.run(true) });
      } else this.match(ATTR);
    }
    while (this.i < s.length) {
      if (s.startsWith("</", this.i)) {
        const end = s.indexOf(">", this.i);
        this.i = end < 0 ? s.length : end + 1;
        return node;
      }
      if (s[this.i] === "<") node.children.push({ k: "node", node: this.element() });
      else if (s[this.i] === "{") {
        this.i++;
        node.children.push({ k: "expr", toks: this.run(true) });
      } else {
        // JSX text: an apostrophe here is a character, not the start of a string
        this.i++;
      }
    }
    return node;
  }
}

// ---- values ----

type Val =
  | { t: "arr"; elems: Array<{ spread: boolean; v: Val }> }
  | { t: "obj"; props: Map<string, Val>; spreads: Val[] }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "jsx"; node: JsxNode }
  | { t: "import"; spec: string }
  | { t: "call"; callee: string; args: Val[] }
  | { t: "other" };

const OTHER: Val = { t: "other" };
const isP = (t: Tok | undefined, v: string) => t?.k === "p" && t.v === v;
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** past the bracket that closes the one at `i` */
function skipBalanced(toks: Tok[], i: number): number {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    const t = toks[j]!;
    if (t.k !== "p") continue;
    if (t.v in OPEN) depth++;
    else if (t.v === ")" || t.v === "]" || t.v === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return toks.length;
}

/** the next comma at this level, or `limit` */
function nextComma(toks: Tok[], from: number, limit: number): number {
  let j = from;
  while (j < limit) {
    const t = toks[j];
    if (t?.k === "p" && t.v in OPEN) j = skipBalanced(toks, j);
    else if (isP(t, ",")) return j;
    else j++;
  }
  return limit;
}

/** the first `import("…")` between `from` and `to` */
function findImport(toks: Tok[], from: number, to: number): Val {
  for (let j = from; j < to - 2; j++) {
    const s = toks[j + 2];
    if (toks[j]?.k === "id" && (toks[j] as { v: string }).v === "import" && isP(toks[j + 1], "(") && s?.k === "str") {
      return { t: "import", spec: s.v };
    }
  }
  return OTHER;
}

function parseArrowBody(toks: Tok[], i: number): [Val, number] {
  if (isP(toks[i], "{")) {
    const end = skipBalanced(toks, i);
    return [findImport(toks, i, end), end];
  }
  return parseValue(toks, i);
}

function parseArgs(toks: Tok[], open: number): [Val[], number] {
  const end = skipBalanced(toks, open);
  const args: Val[] = [];
  let j = open + 1;
  while (j < end - 1) {
    if (isP(toks[j], ",")) {
      j++;
      continue;
    }
    const [v, n] = parseValue(toks, j);
    args.push(v);
    j = nextComma(toks, Math.max(n, j + 1), end - 1);
  }
  return [args, end];
}

function parseValue(toks: Tok[], i: number): [Val, number] {
  const t = toks[i];
  if (!t) return [OTHER, i + 1];
  if (t.k === "str") return [{ t: "str", v: t.v }, i + 1];
  if (t.k === "jsx") return [{ t: "jsx", node: t.node }, i + 1];
  if (t.k === "tpl") return [OTHER, i + 1];
  if (t.k === "p") {
    if (t.v === "[") return parseArray(toks, i);
    if (t.v === "{") return parseObject(toks, i);
    if (t.v === "(") {
      const close = skipBalanced(toks, i);
      if (isP(toks[close], "=>")) return parseArrowBody(toks, close + 1);
      return [parseValue(toks, i + 1)[0], close];
    }
    return [OTHER, i + 1];
  }
  if (t.v === "true" || t.v === "false") return [{ t: "bool", v: t.v === "true" }, i + 1];
  if (t.v === "async") return parseValue(toks, i + 1);
  const spec = toks[i + 2];
  if (t.v === "import" && isP(toks[i + 1], "(") && spec?.k === "str") {
    return [{ t: "import", spec: spec.v }, skipBalanced(toks, i + 1)];
  }
  let name = t.v;
  let j = i + 1;
  while (isP(toks[j], ".") && toks[j + 1]?.k === "id") {
    name += `.${(toks[j + 1] as { v: string }).v}`;
    j += 2;
  }
  if (isP(toks[j], "=>")) return parseArrowBody(toks, j + 1);
  if (isP(toks[j], "(")) {
    const [args, end] = parseArgs(toks, j);
    return [{ t: "call", callee: name, args }, end];
  }
  return [{ t: "id", v: name }, j];
}

function parseArray(toks: Tok[], i: number): [Val, number] {
  const end = skipBalanced(toks, i);
  const elems: Array<{ spread: boolean; v: Val }> = [];
  let j = i + 1;
  while (j < end - 1) {
    if (isP(toks[j], ",")) {
      j++;
      continue;
    }
    const spread = isP(toks[j], "...");
    const [v, n] = parseValue(toks, spread ? j + 1 : j);
    elems.push({ spread, v });
    j = nextComma(toks, Math.max(n, j + 1), end - 1);
  }
  return [{ t: "arr", elems }, end];
}

function parseObject(toks: Tok[], i: number): [Val, number] {
  const end = skipBalanced(toks, i);
  const props = new Map<string, Val>();
  const spreads: Val[] = [];
  let j = i + 1;
  while (j < end - 1) {
    if (isP(toks[j], ",")) {
      j++;
      continue;
    }
    if (isP(toks[j], "...")) {
      const [v, n] = parseValue(toks, j + 1);
      spreads.push(v);
      j = nextComma(toks, n, end - 1);
      continue;
    }
    // `async lazy() { … }`: the key is the word after async
    if (toks[j]?.k === "id" && (toks[j] as { v: string }).v === "async" && toks[j + 1]?.k === "id") j++;
    const t = toks[j]!;
    const key = t.k === "id" || t.k === "str" ? t.v : null;
    if (key !== null && isP(toks[j + 1], ":")) {
      const [v, n] = parseValue(toks, j + 2);
      props.set(key, v);
      j = nextComma(toks, n, end - 1);
    } else if (key !== null && isP(toks[j + 1], "(")) {
      // a method: `lazy() { return import("./Page") }`
      const params = skipBalanced(toks, j + 1);
      const body = isP(toks[params], "{") ? skipBalanced(toks, params) : params;
      props.set(key, findImport(toks, params, body));
      j = nextComma(toks, body, end - 1);
    } else if (key !== null && (isP(toks[j + 1], ",") || j + 1 >= end - 1)) {
      props.set(key, { t: "id", v: key });
      j++;
    } else j = nextComma(toks, j + 1, end - 1);
  }
  return [{ t: "obj", props, spreads }, end];
}

// ---- one file, read ----

interface Parsed {
  path: string;
  toks: Tok[];
  /** local name to the module and the name it has there */
  imports: Map<string, { spec: string; name: string }>;
  consts: Map<string, { val: Val; typed: boolean }>;
  /** what this file calls <Route>, aliases included */
  routeTags: Set<string>;
}

const ROUTER_MODULE = /^react-router(-dom)?$/;
const ROUTER_CALLS = new Set(["createBrowserRouter", "createHashRouter", "useRoutes"]);

function parse(file: SourceFile): Parsed {
  const toks = new Lexer(file.text, /\.(tsx|jsx|js)$/.test(file.path)).run();
  const imports = new Map<string, { spec: string; name: string }>();
  const consts = new Map<string, { val: Val; typed: boolean }>();
  const routeTags = new Set<string>();
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j]!;
    if (t.k !== "id") continue;
    if (t.v === "import" && !isP(toks[j + 1], "(")) {
      let k = j + 1;
      const clause: Tok[] = [];
      while (
        k < toks.length &&
        !(toks[k]?.k === "id" && (toks[k] as { v: string }).v === "from") &&
        toks[k]?.k !== "str"
      ) {
        clause.push(toks[k]!);
        k++;
      }
      const specTok = toks[k]?.k === "str" ? toks[k] : toks[k + 1];
      if (specTok?.k !== "str") continue;
      const spec = specTok.v;
      let inBraces = false;
      for (let c = 0; c < clause.length; c++) {
        const ct = clause[c]!;
        if (isP(ct, "{")) inBraces = true;
        else if (isP(ct, "}")) inBraces = false;
        else if (ct.k === "id" && ct.v !== "type" && ct.v !== "as") {
          const aliased = clause[c + 1]?.k === "id" && (clause[c + 1] as { v: string }).v === "as";
          const local = aliased ? (clause[c + 2] as { v: string } | undefined)?.v : ct.v;
          if (!local) continue;
          const name = inBraces
            ? ct.v
            : isP(clause[c - 1], "*") || (clause[c - 1]?.k === "id" && (clause[c - 1] as { v: string }).v === "as")
              ? "*"
              : "default";
          if (!(clause[c - 1]?.k === "id" && (clause[c - 1] as { v: string }).v === "as")) {
            imports.set(local, { spec, name });
            if (inBraces && ct.v === "Route" && ROUTER_MODULE.test(spec)) routeTags.add(local);
          }
          if (aliased) c += 2;
        }
      }
      j = k;
    } else if ((t.v === "const" || t.v === "let" || t.v === "var") && toks[j + 1]?.k === "id") {
      const name = (toks[j + 1] as { v: string }).v;
      let k = j + 2;
      let typed = false;
      while (k < toks.length && k < j + 24 && !isP(toks[k], "=") && !isP(toks[k], ";")) {
        if (toks[k]?.k === "id" && (toks[k] as { v: string }).v === "RouteObject") typed = true;
        k++;
      }
      if (!isP(toks[k], "=")) continue;
      const [val, n] = parseValue(toks, k + 1);
      const after = toks[n];
      if (
        after?.k === "id" &&
        (after.v === "satisfies" || after.v === "as") &&
        (toks[n + 1] as { v?: string })?.v === "RouteObject"
      )
        typed = true;
      consts.set(name, { val, typed });
    }
  }
  return { path: file.path, toks, imports, consts, routeTags };
}

// ---- routes ----

const MODULE_EXTS = ["", ".tsx", ".ts", ".jsx", ".js", ".mts", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

/** a relative or `@/`, `~/` import as a file under the root; null for a package */
function resolveModule(from: string, spec: string, known: Set<string>): string | null {
  let base: string;
  if (spec.startsWith("./") || spec.startsWith("../")) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else if (spec.startsWith("@/") || spec.startsWith("~/")) base = `src/${spec.slice(2)}`;
  else return null;
  for (const ext of MODULE_EXTS) if (known.has(base + ext)) return base + ext;
  return null;
}

/** a child path under its parent's; a leading slash makes it absolute */
function joinPath(base: string, path: string): string {
  const joined = path.startsWith("/") ? path : `${base}/${path}`;
  const clean = joined.replace(/\/+/g, "/").replace(/\/$/, "");
  return clean || "/";
}

/** A route draws a page only through one of these. Without any, it is a group that lends its path
 * to its children, or a loader or action with nothing to look at, and its own address is a blank
 * outlet nobody means to visit. */
const RENDERS = ["element", "Component", "lazy"];

/** the component an element finally renders: the innermost capitalised tag, so <Suspense><Page/> is Page */
function leafComponent(node: JsxNode): string | null {
  for (const c of node.children) {
    if (c.k !== "node") continue;
    const inner = leafComponent(c.node);
    if (inner) return inner;
  }
  return /^[A-Z]/.test(node.name) ? node.name.split(".")[0]! : null;
}

class Reader {
  private found = new Map<string, { route: CodeRoute; index: boolean }>();
  /** consts reached as someone's children or spread, so they are not read again as a root */
  private used = new Set<string>();

  constructor(
    private files: Map<string, Parsed>,
    private known: Set<string>,
  ) {}

  read(): CodeRoute[] {
    for (const p of this.files.values()) {
      for (const node of this.topRoutes(p.toks, p)) this.jsxRoute(p, node, "/");
      for (let j = 0; j < p.toks.length; j++) {
        const t = p.toks[j]!;
        if (t.k !== "id" || !ROUTER_CALLS.has(t.v) || !isP(p.toks[j + 1], "(")) continue;
        const [args] = parseArgs(p.toks, j + 1);
        const routes = args[0] ? this.arrayOf(p, args[0], 0) : null;
        if (routes) this.objectRoutes(routes.p, routes.val, "/", routes.hop);
      }
    }
    // a const typed as routes and never reached from a router: its own root
    for (const p of this.files.values()) {
      for (const [name, c] of p.consts) {
        if (c.typed && c.val.t === "arr" && !this.used.has(`${p.path}#${name}`)) this.objectRoutes(p, c.val, "/", 0);
      }
    }
    return [...this.found.values()].map((f) => f.route);
  }

  private emit(path: string, file: string, index: boolean): void {
    // a catch-all at the root is the not-found page: nowhere anyone navigates to on purpose
    if (path === "/*") return;
    const had = this.found.get(path);
    // an index route is the page its parent's path shows, so its file is the one that path means
    if (had && (had.index || !index)) return;
    this.found.set(path, { route: { path, file, dynamic: /[:*]/.test(path), endpoint: false }, index });
  }

  /** every <Route> not inside another, anywhere in these tokens */
  private *topRoutes(toks: Tok[], p: Parsed): Generator<JsxNode> {
    for (const t of toks) if (t.k === "jsx") yield* this.routesIn(t.node, p);
  }

  private *routesIn(node: JsxNode, p: Parsed): Generator<JsxNode> {
    if (p.routeTags.has(node.name)) {
      yield node;
      return;
    }
    for (const a of node.attrs.values()) if (a.k === "expr") yield* this.topRoutes(a.toks, p);
    for (const c of node.children) {
      if (c.k === "node") yield* this.routesIn(c.node, p);
      else yield* this.topRoutes(c.toks, p);
    }
  }

  private jsxRoute(p: Parsed, node: JsxNode, base: string): void {
    const pathAttr = node.attrs.get("path");
    const indexAttr = node.attrs.get("index");
    const index =
      indexAttr?.k === "bare" ||
      (indexAttr?.k === "expr" && indexAttr.toks[0]?.k === "id" && indexAttr.toks[0].v === "true");
    // a path that is not a literal cannot be listed, and nor can anything under it
    if (pathAttr && pathAttr.k !== "str") return;
    const full = index || !pathAttr ? base : joinPath(base, pathAttr.v);
    if ((pathAttr || index) && RENDERS.some((k) => node.attrs.has(k)))
      this.emit(full, this.fileOfElement(p, node), index);
    for (const child of this.childRoutes(node, p)) this.jsxRoute(p, child, full);
  }

  private *childRoutes(node: JsxNode, p: Parsed): Generator<JsxNode> {
    for (const c of node.children) if (c.k === "node") yield* this.routesIn(c.node, p);
  }

  private fileOfElement(p: Parsed, node: JsxNode): string {
    const element = node.attrs.get("element");
    if (element?.k === "expr") {
      const jsx = element.toks.find((t) => t.k === "jsx");
      const name = jsx?.k === "jsx" ? leafComponent(jsx.node) : null;
      if (name) return this.fileOfName(p, name);
    }
    const component = node.attrs.get("Component");
    if (component?.k === "expr" && component.toks[0]?.k === "id") return this.fileOfName(p, component.toks[0].v);
    const lazy = node.attrs.get("lazy");
    if (lazy?.k === "expr") {
      const v = findImport(lazy.toks, 0, lazy.toks.length);
      if (v.t === "import") return resolveModule(p.path, v.spec, this.known) ?? p.path;
    }
    return p.path;
  }

  private fileOfName(p: Parsed, name: string): string {
    const imported = p.imports.get(name);
    return (imported && resolveModule(p.path, imported.spec, this.known)) || p.path;
  }

  private fileOfObject(p: Parsed, obj: Extract<Val, { t: "obj" }>): string {
    const element = obj.props.get("element");
    if (element?.t === "jsx") {
      const name = leafComponent(element.node);
      if (name) return this.fileOfName(p, name);
    }
    const component = obj.props.get("Component");
    if (component?.t === "id") return this.fileOfName(p, component.v);
    const lazy = obj.props.get("lazy");
    if (lazy?.t === "import") return resolveModule(p.path, lazy.spec, this.known) ?? p.path;
    return p.path;
  }

  /** a const by name: this file's own, or, one import away, the file it comes from */
  private constOf(p: Parsed, name: string, hop: number): { p: Parsed; val: Val; hop: number } | null {
    const own = p.consts.get(name);
    if (own) {
      this.used.add(`${p.path}#${name}`);
      return { p, val: own.val, hop };
    }
    const imported = p.imports.get(name);
    if (!imported || hop > 0) return null;
    const file = resolveModule(p.path, imported.spec, this.known);
    const q = file ? this.files.get(file) : undefined;
    const there = q?.consts.get(imported.name);
    if (!q || !there) return null;
    this.used.add(`${q.path}#${imported.name}`);
    return { p: q, val: there.val, hop: hop + 1 };
  }

  private arrayOf(p: Parsed, v: Val, hop: number): { p: Parsed; val: Extract<Val, { t: "arr" }>; hop: number } | null {
    if (v.t === "arr") return { p, val: v, hop };
    if (v.t !== "id") return null;
    const c = this.constOf(p, v.v, hop);
    return c && c.val.t === "arr" ? { p: c.p, val: c.val, hop: c.hop } : null;
  }

  private objectRoutes(p: Parsed, arr: Extract<Val, { t: "arr" }>, base: string, hop: number): void {
    for (const el of arr.elems) {
      if (el.spread) {
        const spread = this.arrayOf(p, el.v, hop);
        if (spread) this.objectRoutes(spread.p, spread.val, base, spread.hop);
        continue;
      }
      let owner = p;
      let ownerHop = hop;
      let v = el.v;
      if (v.t === "id") {
        const c = this.constOf(p, v.v, hop);
        if (!c) continue;
        owner = c.p;
        ownerHop = c.hop;
        v = c.val;
      }
      if (v.t !== "obj") continue;
      const pathVal = v.props.get("path");
      if (pathVal && pathVal.t !== "str") continue;
      const indexVal = v.props.get("index");
      const index = indexVal?.t === "bool" && indexVal.v;
      const full = index || !pathVal ? base : joinPath(base, pathVal.v);
      if ((pathVal || index) && RENDERS.some((k) => v.props.has(k)))
        this.emit(full, this.fileOfObject(owner, v), index);
      const children = v.props.get("children");
      const nested = children ? this.arrayOf(owner, children, ownerHop) : null;
      if (nested) this.objectRoutes(nested.p, nested.val, full, nested.hop);
    }
  }
}

/** The routes these files declare, with paths from the app's root. `paths` is every file under the
 * root, for resolving imports. A hash router's pages are keyed the way the address bar keys them. */
export function reactRoutes(files: SourceFile[], paths: string[]): CodeRoute[] {
  const parsed = new Map(files.map((f) => [f.path, parse(f)]));
  const routes = new Reader(parsed, new Set(paths)).read();
  if (!files.some((f) => /createHashRouter|<HashRouter\b/.test(f.text))) return routes;
  return routes.map((r) => (r.path === "/" ? r : { ...r, path: `/#${r.path}` }));
}
