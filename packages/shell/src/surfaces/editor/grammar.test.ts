import { beforeAll, describe, expect, test } from "bun:test";
import { grammarsReady, initialState, tokenizeLine, tokenOf } from "./grammar.ts";

beforeAll(() => grammarsReady);

/** a file's lines, as `token:text` per coloured run, with body text left out */
function paint(language: string, text: string): string[] {
  let state = initialState();
  return text.split("\n").map((line) => {
    const r = tokenizeLine(language, line, state);
    state = r.endState;
    // the grammar splits a run its scopes tell apart and the theme does not, `/*` from the words after it
    const runs: { token: string; text: string }[] = [];
    for (const [i, t] of r.tokens.entries()) {
      const text = line.slice(t.startIndex, r.tokens[i + 1]?.startIndex ?? line.length);
      const last = runs.at(-1);
      if (last && last.token === t.scopes) last.text += text;
      else runs.push({ token: t.scopes, text });
    }
    return runs
      .filter((t) => t.token && t.token !== "identifier" && t.text.trim())
      .map((t) => `${t.token}:${t.text.trim()}`)
      .join(" ");
  });
}

describe("tokenOf", () => {
  test("a scope takes its longest listed prefix, and the innermost scope that has one wins", () => {
    expect(tokenOf(["source.tsx", "meta.function-call.tsx", "entity.name.function.tsx"])).toBe("function");
    expect(tokenOf(["source.tsx", "keyword.operator.new.tsx"])).toBe("keyword");
    expect(tokenOf(["source.tsx", "keyword.operator.assignment.tsx"])).toBe("operator");
  });

  test("JSX text is body text, whatever it sits inside", () => {
    expect(tokenOf(["source.tsx", "string.template.tsx", "meta.jsx.children.tsx"])).toBe("");
  });

  test("a scope nothing names is body text", () => {
    expect(tokenOf(["source.tsx", "meta.var.expr.tsx"])).toBe("");
  });
});

describe("tokenizeLine", () => {
  test("a call is a function, where the monarch tokenizer left it as any other word", () => {
    const [line] = paint("typescriptreact", `fetch("/api").then((r) => r.json());`);
    expect(line).toContain("function:fetch");
    expect(line).toContain("function:then");
    expect(line).toContain("function:json");
  });

  test("JSX reads as markup: a tag, its attributes, its text left plain, and an entity", () => {
    const [open, text] = paint(
      "typescriptreact",
      `<a className="brand" href="#">\n  Milkweed &amp; Sage in the open for this fall\n</a>`,
    );
    expect(open).toBe(
      `delimiter:< tag:a attribute.name:className operator:= string:"brand" attribute.name:href operator:= string:"#" delimiter:>`,
    );
    // no keyword out of `in`, `for` or `this`, and no type out of a capitalised word
    expect(text).toBe("string.escape:&amp;");
  });

  test("a component tag is a type", () => {
    const [line] = paint("typescriptreact", "<PlantCard plant={p} />");
    expect(line).toContain("type:PlantCard");
  });

  test("a generic arrow in a .ts file is not a JSX tag, and the lines after it still colour", () => {
    const [arrow, after] = paint("typescript", `const first = <T>(xs: T[]): T => xs[0];\nconst n: number = 1;`);
    expect(arrow).not.toContain("tag:");
    expect(arrow).toContain("type:T");
    expect(after).toBe("keyword:const operator:: type:number operator:= number:1 delimiter:;");
  });

  test("state carries across lines: a block comment colours every line it covers", () => {
    const lines = paint("javascript", "/* one\ntwo */ const x = 1;");
    expect(lines[0]).toBe("comment:/* one");
    expect(lines[1]).toContain("comment:two */");
    expect(lines[1]).toContain("keyword:const");
  });

  test("a YAML key is a key, not the tag the grammar calls it", () => {
    const [line] = paint("yaml", "name: toyon");
    expect(line).toContain("key:name");
  });
});
