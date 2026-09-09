import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT } from "./exec.ts";
import { commitFiles, fileAtCommit, logCommits } from "./log.ts";

const { repo, cleanup } = tmpRepo();
afterAll(cleanup);

/** the tmp repo starts on main with one commit; give it a branch two commits ahead */
function commit(message: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  sh(repo, GIT, "add", "-A");
  sh(repo, GIT, "commit", "-q", "-m", message);
  return sh(repo, GIT, "rev-parse", "HEAD");
}

sh(repo, GIT, "checkout", "-q", "-b", "feature");
const first = commit("add a and b", { "a.ts": "one\ntwo\n", "b.ts": "b\n" });
const second = commit("edit a, drop b", { "a.ts": "one\ntwo\nthree\n" });
sh(repo, GIT, "rm", "-q", "b.ts");
sh(repo, GIT, "commit", "-q", "-m", "remove b");
const third = sh(repo, GIT, "rev-parse", "HEAD");

describe("logCommits", () => {
  test("newest first, with the commits ahead of main flagged", async () => {
    const commits = await logCommits(repo, "main");
    expect(commits.map((c) => c.subject)).toEqual(["remove b", "edit a, drop b", "add a and b", "init"]);
    expect(commits.map((c) => c.ahead)).toEqual([true, true, true, false]);
    expect(commits[0]?.sha).toBe(third);
    expect(commits[0]?.author).toBe("t");
    // the short sha is a prefix of the full one, and the date is milliseconds, not seconds
    expect(third.startsWith(commits[0]?.short ?? "x")).toBe(true);
    expect(commits[0]?.at).toBeGreaterThan(1_600_000_000_000);
  });

  test("nothing is ahead when HEAD is the default branch itself", async () => {
    const commits = await logCommits(repo, "feature");
    expect(commits.every((c) => !c.ahead)).toBe(true);
  });

  test("the limit bounds the list", async () => {
    expect(await logCommits(repo, "main", 2)).toHaveLength(2);
  });
});

describe("commitFiles", () => {
  test("adds, edits and deletes, each with its line counts", async () => {
    expect(await commitFiles(repo, first)).toEqual([
      { xy: "A ", path: "a.ts", add: 2, del: 0 },
      { xy: "A ", path: "b.ts", add: 1, del: 0 },
    ]);
    expect(await commitFiles(repo, second)).toEqual([{ xy: "M ", path: "a.ts", add: 1, del: 0 }]);
    expect(await commitFiles(repo, third)).toEqual([{ xy: "D ", path: "b.ts", add: 0, del: 1 }]);
  });

  test("a sha that is not a commit is an empty list, not a throw", async () => {
    expect(await commitFiles(repo, "0".repeat(40))).toEqual([]);
  });
});

describe("fileAtCommit", () => {
  test("both sides of an edit", async () => {
    expect(await fileAtCommit(repo, second, "a.ts")).toEqual({ before: "one\ntwo", after: "one\ntwo\nthree" });
  });

  test("a file the commit added has no before side", async () => {
    expect(await fileAtCommit(repo, first, "a.ts")).toEqual({ before: "", after: "one\ntwo" });
  });

  test("a file the commit deleted has no after side", async () => {
    expect(await fileAtCommit(repo, third, "b.ts")).toEqual({ before: "b", after: "" });
  });

  test("a path outside the repo reads as empty rather than escaping it", async () => {
    expect(await fileAtCommit(repo, third, "../../etc/passwd")).toEqual({ before: "", after: "" });
  });
});
