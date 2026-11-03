import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import { codeLink, githubRef, linkedCodespan } from "./markdownGithub.ts";

const link = (repo: string, n: string) => `<a href="https://github.com/${repo}/issues/${n}">${repo}#${n}</a>`;

describe("owner/repo#123 in the agent's prose", () => {
  const md = new Marked({ extensions: [githubRef] });
  const render = (s: string) => md.parseInline(s, { async: false }) as string;

  test("links to the issue, the sentence's punctuation left outside", () => {
    expect(render("see anthropics/claude-code#95558.")).toBe(`see ${link("anthropics/claude-code", "95558")}.`);
    expect(render("(toyon-dev/toyon#12)")).toBe(`(${link("toyon-dev/toyon", "12")})`);
  });
  test("inside emphasis, the same", () => {
    expect(render("**a/b#1**")).toBe(`<strong>${link("a/b", "1")}</strong>`);
  });
  test("a repository may carry dots and underscores", () => {
    expect(render("anthropic-ai/claude_sdk.js#7")).toBe(link("anthropic-ai/claude_sdk.js", "7"));
  });
  test("the fragment of an address is not a reference", () => {
    expect(render("https://github.com/a/b#12")).toBe(
      '<a href="https://github.com/a/b#12">https://github.com/a/b#12</a>',
    );
    expect(render("see github.com/a/b#12")).toBe("see github.com/a/b#12");
  });
  test("a segment of a path, a bare number, and a word running on are not references", () => {
    expect(render("/src/a/b#1 and #12 and a/b#1x and a/b#1-2")).toBe("/src/a/b#1 and #12 and a/b#1x and a/b#1-2");
  });
});

describe("a code span that is a place whole", () => {
  const md = new Marked({ extensions: [githubRef], renderer: { codespan: linkedCodespan } });
  const render = (s: string) => md.parseInline(s, { async: false }) as string;

  test("a backticked reference or address is the link, the code kept inside it", () => {
    expect(render("see `a/b#1`")).toBe('see <a href="https://github.com/a/b/issues/1"><code>a/b#1</code></a>');
    expect(render('`https://x.test/a?b=1&c="2"`')).toBe(
      '<a href="https://x.test/a?b=1&amp;c=&quot;2&quot;"><code>https://x.test/a?b=1&amp;c="2"</code></a>',
    );
  });
  test("code that is more than the place, or no place, stays code", () => {
    expect(render("`gh issue view a/b#1` and `a/b` and `<b>`")).toBe(
      "<code>gh issue view a/b#1</code> and <code>a/b</code> and <code>&lt;b&gt;</code>",
    );
  });
  test("codeLink is what the person's own backticks read by", () => {
    expect(codeLink("https://x.test/a")).toBe("https://x.test/a");
    expect(codeLink("a/b#1")).toBe("https://github.com/a/b/issues/1");
    expect(codeLink("https://x.test/a b")).toBeNull();
    expect(codeLink("src/App.tsx")).toBeNull();
  });
});
