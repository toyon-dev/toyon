import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT } from "./exec.ts";
import {
  aheadUpstream,
  changedRanges,
  countEntries,
  filesBetween,
  foldDropped,
  parseNameStatus,
  parseNumstat,
  parsePorcelain,
  reaches,
  remoteHead,
  statusEntries,
  statusFiles,
  statusFilesWithCounts,
  treeFingerprint,
} from "./status.ts";

describe("statusFiles", () => {
  const { repo, cleanup } = tmpRepo();
  afterAll(cleanup);

  test("a status read never writes the index", async () => {
    // a tracked file whose stat no longer matches the index: git re-hashes it, finds it unchanged,
    // and would normally write the fresh stat back through .git/index.lock. The daemon reads the
    // main checkout's status every few seconds, so that write collided with a `git pull` typed in
    // a terminal ("Unable to create index.lock: File exists")
    const index = join(repo, ".git", "index");
    const stale = new Date(Date.now() - 3_600_000);
    utimesSync(join(repo, "README.md"), stale, stale);
    const before = statSync(index).mtimeMs;
    expect(await statusFiles(repo)).toEqual([]);
    expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
    expect(statSync(index).mtimeMs).toBe(before);
  });
});

describe("parsePorcelain", () => {
  test("plain modified / added / untracked", () => {
    expect(parsePorcelain(" M src/a.ts\0A  src/b.ts\0?? src/c.ts\0")).toEqual([
      { xy: " M", path: "src/a.ts" },
      { xy: "A ", path: "src/b.ts" },
      { xy: "??", path: "src/c.ts" },
    ]);
  });
  test("renames report the new path, not the old one", () => {
    expect(parsePorcelain("R  new.ts\0old.ts\0")).toEqual([{ xy: "R ", path: "new.ts" }]);
    expect(parsePorcelain("RM new/dir/b.ts\0old/dir/a.ts\0 M c.ts\0")).toEqual([
      { xy: "RM", path: "new/dir/b.ts" },
      { xy: " M", path: "c.ts" },
    ]);
  });
  test("a path is taken whole: an arrow, a space, a quote, a newline", () => {
    expect(parsePorcelain(' M notes/a -> b.md\0?? with space.ts\0?? a"b\nc.ts\0')).toEqual([
      { xy: " M", path: "notes/a -> b.md" },
      { xy: "??", path: "with space.ts" },
      { xy: "??", path: 'a"b\nc.ts' },
    ]);
  });
  test("empty output", () => {
    expect(parsePorcelain("")).toEqual([]);
  });
});

describe("foldDropped", () => {
  test("a path listed as deleted and untracked is one modified entry", () => {
    expect(foldDropped(parsePorcelain("D  a.ts\0 M b.ts\0?? a.ts\0?? c.ts\0"))).toEqual({
      files: [
        { xy: " M", path: "a.ts" },
        { xy: " M", path: "b.ts" },
        { xy: "??", path: "c.ts" },
      ],
      dropped: ["a.ts"],
    });
  });
  test("a deletion on its own, or an untracked file on its own, is left as it is", () => {
    const entries = parsePorcelain("D  a.ts\0?? b.ts\0");
    expect(foldDropped(entries)).toEqual({ files: entries, dropped: [] });
  });
});

describe("parseNumstat and parseNameStatus", () => {
  test("a rename is counted and listed under its new path", () => {
    expect([...parseNumstat("1\t2\ta.ts\0-\t-\tb.bin\x003\t0\t\0old.ts\0new.ts\x004\t4\tc.ts\0")]).toEqual([
      ["a.ts", { add: 1, del: 2 }],
      ["b.bin", {}],
      ["new.ts", { add: 3, del: 0 }],
      ["c.ts", { add: 4, del: 4 }],
    ]);
    expect(parseNameStatus("M\0a.ts\0R087\0old.ts\0new.ts\0D\0c.ts\0")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "R", path: "new.ts" },
      { status: "D", path: "c.ts" },
    ]);
  });
});

// git quotes a name that holds anything past ASCII and writes its bytes in octal, unless it is
// asked for NUL-separated records: one such file in the tree made every status read throw
describe("names git would quote", () => {
  const { repo, cleanup } = tmpRepo();
  afterAll(cleanup);
  const accent = "caf\u00e9.txt";
  const odd = 'a"b\nc d.txt';
  const moved = "docs/na\u00efve \u2192 name.txt";

  test("an untracked file with an accent, a quote or a newline in its name is listed as named", async () => {
    writeFileSync(join(repo, accent), "one\n");
    writeFileSync(join(repo, odd), "one\ntwo\n");
    expect(await statusFilesWithCounts(repo)).toEqual([
      { xy: "??", path: odd, add: 2, del: 0 },
      { xy: "??", path: accent, add: 1, del: 0 },
    ]);
    expect(await statusFiles(repo, accent)).toEqual([{ xy: "??", path: accent }]);
  });

  test("the fingerprint moves when such a file is edited, at the same size", async () => {
    const before = await treeFingerprint(repo);
    writeFileSync(join(repo, accent), "two\n");
    expect(await treeFingerprint(repo)).not.toBe(before);
  });

  test("a tracked edit is counted under the name, and so is a commit's", async () => {
    const from = sh(repo, GIT, "rev-parse", "HEAD");
    sh(repo, GIT, "add", "-A");
    sh(repo, GIT, "commit", "-q", "-m", "names");
    expect(await filesBetween(repo, from, "HEAD")).toEqual([
      { xy: "A ", path: odd, add: 2, del: 0 },
      { xy: "A ", path: accent, add: 1, del: 0 },
    ]);
    writeFileSync(join(repo, accent), "two\nthree\n");
    expect(await statusFilesWithCounts(repo)).toEqual([{ xy: " M", path: accent, add: 1, del: 0 }]);
    expect(await changedRanges(repo, "main", accent)).toEqual([[2, 2]]);
    sh(repo, GIT, "checkout", "-q", "--", accent);
  });

  test("a rename reports the new name, in status and between commits", async () => {
    mkdirSync(join(repo, "docs"));
    sh(repo, GIT, "mv", accent, moved);
    expect(await statusFiles(repo)).toEqual([{ xy: "R ", path: moved }]);
    const from = sh(repo, GIT, "rev-parse", "HEAD");
    sh(repo, GIT, "commit", "-q", "-m", "move");
    // the counts are read without rename detection, so the new name carries the whole file
    expect(await filesBetween(repo, from, "HEAD")).toEqual([{ xy: "R ", path: moved, add: 1, del: 0 }]);
  });
});

describe("a file the index dropped but the disk still holds", () => {
  const { repo, cleanup } = tmpRepo();
  afterAll(cleanup);
  // `git rm --cached` is the state the status panel drew twice: once deleted, once untracked, the
  // same path under two rows, which the shell keys on the path alone
  sh(repo, GIT, "rm", "-q", "--cached", "README.md");

  test("is one row, counted from disk against HEAD rather than through the index", async () => {
    writeFileSync(join(repo, "README.md"), "hello\nworld\n");
    const expected = [{ xy: " M", path: "README.md", add: 1, del: 0 }];
    expect(await statusFiles(repo)).toEqual(expected);
    expect(await statusFiles(repo, "README.md")).toEqual(expected);
    expect(await statusFilesWithCounts(repo)).toEqual(expected);
  });
  test("its changed lines are read the same way", async () => {
    expect(await changedRanges(repo, "main", "README.md")).toEqual([[2, 2]]);
  });
  test("is no change at all when the bytes match HEAD", async () => {
    writeFileSync(join(repo, "README.md"), "hello\n");
    expect(await statusFiles(repo)).toEqual([]);
    expect(await statusFilesWithCounts(repo)).toEqual([]);
  });
});

describe("statusFilesWithCounts", () => {
  const { repo, cleanup } = tmpRepo();
  afterAll(cleanup);

  test("counts an untracked file's lines, and stops counting once there are too many", async () => {
    writeFileSync(join(repo, "one.txt"), "a\nb\nc\n");
    const few = await statusFilesWithCounts(repo);
    expect(few).toEqual([{ xy: "??", path: "one.txt", add: 3, del: 0 }]);
    // past the cap the count would mean reading every file, and the list is a tree to scroll
    // rather than a diff to read: a worktree with no .gitignore lists all of its node_modules
    for (let i = 0; i < 501; i++) writeFileSync(join(repo, `f${i}.txt`), "a\nb\nc\n");
    const many = await statusFilesWithCounts(repo);
    expect(many).toHaveLength(502);
    expect(many.every((f) => f.add === undefined && f.del === undefined)).toBe(true);
  });
});

describe("countEntries", () => {
  const { repo, cleanup } = tmpRepo();
  afterAll(cleanup);

  test("counts what the status lists: a tracked edit, an untracked file, a folded path", async () => {
    writeFileSync(join(repo, "README.md"), "hello\nworld\n");
    writeFileSync(join(repo, "new.txt"), "a\nb");
    writeFileSync(join(repo, "empty.txt"), "");
    writeFileSync(join(repo, "blob.bin"), Buffer.from([1, 0, 2, 3]));
    const { files, folded } = await statusEntries(repo);
    expect(folded.size).toBe(0);
    const counts = await countEntries(repo, files, folded);
    expect(counts.get("README.md")).toEqual({ add: 1, del: 0 });
    // the last line counts without a newline to end it, as git counts it
    expect(counts.get("new.txt")).toEqual({ add: 2, del: 0 });
    expect(counts.get("empty.txt")).toEqual({ add: 0, del: 0 });
    // a binary has no lines to count
    expect(counts.has("blob.bin")).toBe(false);
  });

  test("stops reading untracked files at the byte budget, one file at a time", async () => {
    // the status lists paths in order, and the budget is spent in that order
    rmSync(join(repo, "blob.bin"));
    rmSync(join(repo, "new.txt"));
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), `${"x".repeat(64)}\n`);
    const { files, folded } = await statusEntries(repo);
    // 4 bytes: "a\n" fits, the 65-byte file does not, and the empty file costs nothing
    const counts = await countEntries(repo, files, folded, 4);
    expect(counts.get("a.txt")).toEqual({ add: 1, del: 0 });
    expect(counts.has("b.txt")).toBe(false);
    expect(counts.get("empty.txt")).toEqual({ add: 0, del: 0 });
    // the tracked edit is counted by git, not from the budget
    expect(counts.get("README.md")).toEqual({ add: 1, del: 0 });
  });
});

describe("aheadUpstream", () => {
  const { repo, cleanup } = tmpRepo();
  afterAll(cleanup);
  const origin = join(dirname(repo), "origin.git");
  sh(repo, GIT, "init", "-q", "--bare", "-b", "main", origin);
  sh(repo, GIT, "remote", "add", "origin", origin);
  sh(repo, GIT, "push", "-q", "-u", "origin", "main");

  test("a branch pushed by hand without -u is counted against origin's copy of it", async () => {
    sh(repo, GIT, "checkout", "-q", "-b", "feat");
    sh(repo, GIT, "commit", "-q", "--allow-empty", "-m", "one");
    sh(repo, GIT, "push", "-q", "origin", "feat");
    sh(repo, GIT, "commit", "-q", "--allow-empty", "-m", "two");
    // no upstream and no branch named: nothing to count against
    expect(await aheadUpstream(repo)).toBeNull();
    expect(await aheadUpstream(repo, "feat")).toBe(1);
    // a branch origin never had has no copy to count against either
    expect(await aheadUpstream(repo, "nowhere")).toBeNull();
  });

  test("the upstream answers first once the branch has one", async () => {
    sh(repo, GIT, "push", "-q", "-u", "origin", "feat");
    expect(await aheadUpstream(repo, "feat")).toBe(0);
    sh(repo, GIT, "commit", "-q", "--allow-empty", "-m", "three");
    expect(await aheadUpstream(repo)).toBe(1);
  });

  test("remoteHead is where origin's copy stands; reaches says whether HEAD descends from a commit", async () => {
    // feat was pushed one commit ago: origin's copy is HEAD~1, which HEAD reaches, as it does itself
    const pushed = sh(repo, GIT, "rev-parse", "HEAD~1");
    expect(await remoteHead(repo, "feat")).toBe(pushed);
    expect(await remoteHead(repo, "nowhere")).toBeNull();
    expect(await reaches(repo, pushed)).toBe(true);
    expect(await reaches(repo, sh(repo, GIT, "rev-parse", "HEAD"))).toBe(true);
    // a commit git here never saw (a stranger's PR head) is not reached, and is not an error
    expect(await reaches(repo, "0123456789012345678901234567890123456789")).toBe(false);
  });
});
