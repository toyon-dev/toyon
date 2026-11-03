import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { blameFile, parseBlame } from "./blame.ts";
import { GIT } from "./exec.ts";

const { repo, cleanup } = tmpRepo();
afterAll(cleanup);

function commit(message: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  sh(repo, GIT, "add", "-A");
  sh(repo, GIT, "commit", "-q", "-m", message);
  return sh(repo, GIT, "rev-parse", "HEAD");
}

const first = commit("add a", { "a.ts": "one\ntwo\n" });
const second = commit("add three", { "a.ts": "one\ntwo\nthree\n" });
// a line typed since, saved and not committed
writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\nfour\n");
writeFileSync(join(repo, "new.ts"), "never added\n");

describe("blameFile", () => {
  test("names each line's commit, in order of first appearance, and a typed line as none", async () => {
    const b = await blameFile(repo, "a.ts");
    expect(b.commits.map((c) => c.subject)).toEqual(["add a", "add three"]);
    expect(b.commits.map((c) => c.sha)).toEqual([first, second]);
    expect(b.commits[0]?.author).toBe("t");
    expect(b.commits[0]?.email).toBe("t@t");
    expect(b.commits[0]?.at).toBeGreaterThan(1_600_000_000_000);
    expect(b.lines).toEqual([0, 0, 1, -1]);
  });

  test("a ref blames the file as that commit left it", async () => {
    const b = await blameFile(repo, "a.ts", first);
    expect(b.commits.map((c) => c.subject)).toEqual(["add a"]);
    expect(b.lines).toEqual([0, 0]);
  });

  test("a file git does not have is empty, not a throw", async () => {
    expect(await blameFile(repo, "new.ts")).toEqual({ commits: [], lines: [] });
    expect(await blameFile(repo, "missing.ts")).toEqual({ commits: [], lines: [] });
  });

  const unlinked = async () => (await blameFile(repo, "a.ts")).commits.every((c) => c.url === undefined);

  test("with no origin, one off GitHub, or one nothing was fetched from, no commit has a page", async () => {
    expect(await unlinked()).toBe(true);
    try {
      sh(repo, GIT, "remote", "add", "origin", "git@gitlab.com:o/r.git");
      expect(await unlinked()).toBe(true);
      sh(repo, GIT, "remote", "set-url", "origin", "git@github.com:o/r.git");
      expect(await unlinked()).toBe(true);
    } finally {
      sh(repo, GIT, "remote", "remove", "origin");
    }
  });

  test("an origin on GitHub gives the commits it has a page, the pull request when the subject names one", async () => {
    sh(repo, GIT, "remote", "add", "origin", "git@github.com:o/r.git");
    const third = commit("merged upstream (#9)", { "a.ts": "one\ntwo\nthree\nfour\n" });
    // origin has the first two commits, as if fetched; the third is only here
    sh(repo, GIT, "update-ref", "refs/remotes/origin/main", second);
    const b = await blameFile(repo, "a.ts");
    expect(b.commits.map((c) => c.sha)).toEqual([first, second, third]);
    expect(b.commits.map((c) => [c.url, c.pr])).toEqual([
      [`https://github.com/o/r/commit/${first}`, undefined],
      [`https://github.com/o/r/commit/${second}`, undefined],
      [undefined, undefined],
    ]);
    // pushed since: the subject's pull request is the page
    sh(repo, GIT, "update-ref", "refs/remotes/origin/main", third);
    const pushed = (await blameFile(repo, "a.ts")).commits[2];
    expect([pushed?.url, pushed?.pr]).toEqual(["https://github.com/o/r/pull/9", 9]);
  });
});

describe("parseBlame", () => {
  test("a commit's fields come once and hold for its later runs", () => {
    const sha = "a".repeat(40);
    const other = "b".repeat(40);
    const out = [
      `${sha} 1 1 1`,
      "author Kyle",
      "author-mail <k@x>",
      "author-time 1700000000",
      "author-tz +0100",
      "committer Kyle",
      "committer-mail <k@x>",
      "committer-time 1700000000",
      "committer-tz +0100",
      "summary first: one",
      "filename a.ts",
      "\tone",
      `${other} 2 2 1`,
      "author Someone Else",
      "author-mail <s@x>",
      "author-time 1700001000",
      "author-tz +0100",
      "committer Someone Else",
      "committer-mail <s@x>",
      "committer-time 1700001000",
      "committer-tz +0100",
      "summary",
      `previous ${sha} a.ts`,
      "filename a.ts",
      "\ttwo",
      `${sha} 3 3 1`,
      "\tthree",
      "",
    ].join("\n");
    expect(parseBlame(out)).toEqual({
      commits: [
        { sha, author: "Kyle", email: "k@x", at: 1_700_000_000_000, subject: "first: one" },
        { sha: other, author: "Someone Else", email: "s@x", at: 1_700_001_000_000, subject: "" },
      ],
      lines: [0, 1, 0],
    });
  });

  test("nothing printed is nothing blamed", () => {
    expect(parseBlame("")).toEqual({ commits: [], lines: [] });
  });
});
