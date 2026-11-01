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
    // an owner page is not a repo, and is left as typed: git says so at clone time, in its own words
    expect(gitUrl("https://github.com/x/")?.name).toBe("x");
    expect(gitUrl("https://git.example.com/x/y/tree/dev")?.name).toBe("dev");
  });

  test("a page copied from the address bar is read back to the repository it is on", () => {
    const repo = { url: "https://github.com/x/y", name: "y" };
    expect(gitUrl("https://github.com/x/y/pull/12")).toEqual(repo);
    expect(gitUrl("https://github.com/x/y/issues/3#issuecomment-1")).toEqual(repo);
    expect(gitUrl("https://github.com/x/y/actions")).toEqual(repo);
    expect(gitUrl("https://github.com/x/y/commit/abc123")).toEqual(repo);
    expect(gitUrl("https://github.com/x/y.git/pulls")?.url).toBe("https://github.com/x/y.git");
  });

  test("a page on a branch names that branch", () => {
    expect(gitUrl("https://github.com/x/y/tree/feat/thing")).toEqual({
      url: "https://github.com/x/y",
      name: "y",
      branch: "feat/thing",
    });
    expect(gitUrl("https://github.com/x/y/blob/dev/src/a.ts")?.branch).toBe("dev");
    expect(gitUrl("https://github.com/x/y/commits/dev")?.branch).toBe("dev");
    expect(gitUrl("https://github.com/x/y/tree/release%2F1.0")?.branch).toBe("release/1.0");
    expect(gitUrl("https://github.com/x/y/tree/")).toEqual({ url: "https://github.com/x/y", name: "y" });
  });

  test("the scheme a browser's address bar drops is put back", () => {
    expect(gitUrl("github.com/x/y")).toEqual({ url: "https://github.com/x/y", name: "y" });
    expect(gitUrl("github.com/x/y/tree/dev")?.branch).toBe("dev");
    expect(gitUrl("git.example.com/x/y")?.url).toBe("https://git.example.com/x/y");
    // no dot, no host: a name with a slash in it is nothing to offer
    expect(gitUrl("x/y")).toBeNull();
  });

  test("GitLab keeps its subgroups, and reads its pages past the dash", () => {
    expect(gitUrl("https://gitlab.com/group/sub/thing/-/tree/dev")).toEqual({
      url: "https://gitlab.com/group/sub/thing",
      name: "thing",
      branch: "dev",
    });
    expect(gitUrl("https://gitlab.com/group/sub/thing/-/merge_requests/4")?.url).toBe(
      "https://gitlab.com/group/sub/thing",
    );
    expect(gitUrl("https://gitlab.com/group/sub/thing/-/blob/dev/README.md")?.branch).toBe("dev");
  });

  test("Codeberg reads Gitea's src pages", () => {
    expect(gitUrl("https://codeberg.org/x/y/src/branch/dev/src/a.ts")).toEqual({
      url: "https://codeberg.org/x/y",
      name: "y",
      branch: "dev",
    });
    expect(gitUrl("https://codeberg.org/x/y/src/commit/abc")).toEqual({ url: "https://codeberg.org/x/y", name: "y" });
  });

  test("rejects a URL that leaves no folder name at all", () => {
    expect(gitUrl("https://github.com/x/.git")).toBeNull();
  });
});
