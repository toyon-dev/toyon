import { describe, expect, test } from "bun:test";
import { compileRoute, type Template, templateFor, templateText } from "./routes.ts";

const compiled = (path: string): Template => {
  const t = compileRoute(path);
  if (!t) throw new Error(`${path} has no parameter`);
  return t;
};

describe("route templates", () => {
  test("every router's parameter syntax matches the pages it should and no others", () => {
    const table: Array<[string, string[], string[]]> = [
      ["/users/[id]", ["/users/42"], ["/users", "/users/42/edit"]],
      ["/users/:id", ["/users/42"], ["/users"]],
      ["/posts/$postId", ["/posts/7"], ["/posts"]],
      ["/shop/[id=integer]", ["/shop/3"], ["/shop"]],
      ["/docs/[...slug]", ["/docs/a", "/docs/a/b"], ["/docs"]],
      ["/docs/[[...slug]]", ["/docs", "/docs/a/b"], ["/doc"]],
      ["/files/*", ["/files", "/files/a/b"], ["/filesx"]],
      ["/[[lang]]/about", ["/about", "/en/about"], ["/en/team"]],
      ["/:lang?/pricing", ["/pricing", "/fr/pricing"], ["/fr/plans"]],
      ["/{-$locale}/blog", ["/blog", "/de/blog"], ["/de/news"]],
      ["/about?/team", ["/team", "/about/team"], ["/other/team"]],
      ["/post-[id]", ["/post-9"], ["/post-", "/post-9/x"]],
      ["/files/{$id}.json", ["/files/7.json"], ["/files/7.xml"]],
      ["/#/users/:id", ["/#/users/5"], ["/users/5"]],
    ];
    for (const [path, yes, no] of table) {
      const t = compiled(path);
      for (const key of yes) expect(t.re.test(key), `${path} should match ${key}`).toBe(true);
      for (const key of no) expect(t.re.test(key), `${path} should not match ${key}`).toBe(false);
    }
  });

  test("a path with no parameter is not a template", () => {
    expect(compileRoute("/pricing")).toBeNull();
    expect(compileRoute("/")).toBeNull();
  });

  test("a page goes under the most particular template, and never under a catch-all at the root", () => {
    const templates = ["/users/[id]", "/users/[...rest]", "/[...all]", "/users/:id/edit"].map(compiled);
    expect(templateFor(templates, "/users/new")?.path).toBe("/users/[id]");
    expect(templateFor(templates, "/users/1/edit")?.path).toBe("/users/:id/edit");
    expect(templateFor(templates, "/users/1/a/b")?.path).toBe("/users/[...rest]");
    expect(templateFor(templates, "/anything/at/all")).toBeNull();
  });

  test("a template is drawn with plain words for its parameters, whatever the router", () => {
    expect(templateText("/users/[id]")).toEqual({ text: "/users/id", params: [[7, 9]], literal: "/users/" });
    expect(templateText("/o/:org/r/:repo")).toEqual({
      text: "/o/org/r/repo",
      params: [
        [3, 6],
        [9, 13],
      ],
      literal: "/o/",
    });
    expect(templateText("/files/{$id}.json")).toEqual({ text: "/files/id.json", params: [[7, 9]], literal: "/files/" });
    expect(templateText("/docs/[...slug]").text).toBe("/docs/slug");
    expect(templateText("/pricing")).toEqual({ text: "/pricing", params: [], literal: "/pricing" });
    expect(templateText("/")).toEqual({ text: "/", params: [], literal: "/" });
  });
});
