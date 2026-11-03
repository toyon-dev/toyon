import { describe, expect, test } from "bun:test";
import { commitPage, githubRepoUrl, prInSubject } from "./forge.ts";

describe("githubRepoUrl", () => {
  test("either form git writes an origin on GitHub in, with or without .git", () => {
    expect(githubRepoUrl("git@github.com:toyon-dev/toyon.git")).toBe("https://github.com/toyon-dev/toyon");
    expect(githubRepoUrl("git@github.com:toyon-dev/toyon")).toBe("https://github.com/toyon-dev/toyon");
    expect(githubRepoUrl("https://github.com/toyon-dev/toyon.git")).toBe("https://github.com/toyon-dev/toyon");
    expect(githubRepoUrl("https://github.com/toyon-dev/toyon/")).toBe("https://github.com/toyon-dev/toyon");
    expect(githubRepoUrl("ssh://git@github.com/toyon-dev/toyon.git")).toBe("https://github.com/toyon-dev/toyon");
  });

  test("an origin anywhere else has no pages known here", () => {
    expect(githubRepoUrl("git@gitlab.com:o/r.git")).toBeNull();
    expect(githubRepoUrl("https://ghe.corp.example/o/r.git")).toBeNull();
    expect(githubRepoUrl("/srv/git/r.git")).toBeNull();
    expect(githubRepoUrl("")).toBeNull();
  });
});

describe("prInSubject", () => {
  test("a squash's trailing number and a merge commit's leading one", () => {
    expect(prInSubject("feat: add search result measurement metadata (#2180)")).toBe(2180);
    expect(prInSubject("Merge pull request #41 from o/branch")).toBe(41);
  });

  test("a number anywhere else is as likely an issue", () => {
    expect(prInSubject("fix #12 crash on open")).toBeNull();
    expect(prInSubject("(#12) first")).toBeNull();
    expect(prInSubject("plain subject")).toBeNull();
  });
});

describe("commitPage", () => {
  const repo = "https://github.com/o/r";
  const sha = "a".repeat(40);
  test("the pull request when the subject names one, the commit's page otherwise", () => {
    expect(commitPage(repo, { sha, subject: "one (#7)" })).toEqual({ url: "https://github.com/o/r/pull/7", pr: 7 });
    expect(commitPage(repo, { sha, subject: "one" })).toEqual({ url: `https://github.com/o/r/commit/${sha}` });
  });
});
