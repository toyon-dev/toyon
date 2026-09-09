import { describe, expect, test } from "bun:test";
import { gitUrl, projectNameError } from "./project.ts";

const ok = (name: string) => expect(projectNameError(name)).toBeNull();
const bad = (name: string) => expect(projectNameError(name)).toBeString();

describe("projectNameError", () => {
  test("takes the names people actually use, unicode included", () => {
    ok("toyon");
    ok("my-app");
    ok("app_2");
    ok("site.v2");
    ok("café");
    ok("  spaced-out  "); // trimmed before it is judged
  });

  test("refuses anything that would not be one new folder", () => {
    bad("");
    bad("   ");
    bad("a/b");
    bad("a\\b");
    bad(".");
    bad("..");
  });

  test("refuses names that would confuse git or hide the folder", () => {
    bad("-x"); // reads as a flag
    bad(".hidden");
    bad("my project"); // a space follows the folder into every command that names it
    bad("x".repeat(101));
  });

  test("refuses control characters, which a filesystem would otherwise accept", () => {
    bad(`a${String.fromCharCode(0)}b`);
    bad(`a${String.fromCharCode(27)}b`);
    bad(`a${String.fromCharCode(127)}b`);
  });
});

describe("gitUrl", () => {
  test("names the folder git itself would have made", () => {
    expect(gitUrl("https://github.com/x/y")).toEqual({ url: "https://github.com/x/y", name: "y" });
    expect(gitUrl("https://github.com/x/y.git")?.name).toBe("y");
    expect(gitUrl("git@github.com:x/y.git")?.name).toBe("y");
    expect(gitUrl("ssh://git@github.com/x/y.git")?.name).toBe("y");
    expect(gitUrl("https://gitlab.com/group/sub/thing")?.name).toBe("thing");
  });

  test("survives the ways a pasted URL is untidy", () => {
    expect(gitUrl("https://github.com/x/y/")?.name).toBe("y");
    expect(gitUrl("  https://github.com/x/y  ")?.url).toBe("https://github.com/x/y");
    expect(gitUrl("https://github.com/x/y?tab=readme")?.name).toBe("y");
  });

  test("is not a path matcher: those belong to the picker's other branch", () => {
    expect(gitUrl("~/Projects/foo")).toBeNull();
    expect(gitUrl("/Users/k/foo")).toBeNull();
    expect(gitUrl("foo")).toBeNull();
    expect(gitUrl("")).toBeNull();
  });

  test("does not try to know which URLs are real repos", () => {
    // an owner page is not a repo, but nothing here knows github's URL shape and the field is
    // provider-agnostic on purpose: git says so at clone time, in its own words
    expect(gitUrl("https://github.com/x/")?.name).toBe("x");
  });

  test("rejects a URL that leaves no folder name at all", () => {
    expect(gitUrl("https://github.com/x/.git")).toBeNull();
  });
});
