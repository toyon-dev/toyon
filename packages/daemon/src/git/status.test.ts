import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT } from "./exec.ts";
import {
  aheadBehind,
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

  test("the one read told to save writes it back, and leaves no lock behind", async () => {
    const index = join(repo, ".git", "index");
    const before = statSync(index).mtimeMs;
    expect((await statusEntries(repo, { save: true })).files).toEqual([]);
    expect(statSync(index).mtimeMs).toBeGreaterThan(before);
    expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
    // what it saved: the next read finds the stat data fresh and has nothing to write
    const saved = statSync(index).mtimeMs;
    expect((await statusEntries(repo, { save: true })).files).toEqual([]);
    expect(statSync(index).mtimeMs).toBe(saved);
  });
});

// records as `git status --porcelain=v2 -z` writes them: the letters, then modes and object names
// the parser reads past, then the path
const OID = "0".repeat(40);
const changed = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 ${OID} ${OID} ${path}\0`;
const renamed = (xy: string, path: string, from: string) =>
  `2 ${xy} N... 100644 100644 100644 ${OID} ${OID} R100 ${path}\0${from}\0`;
const unmerged = (xy: string, path: string) =>
  `u ${xy} N... 100644 100644 100644 100644 ${OID} ${OID} ${OID} ${path}\0`;
const untracked = (path: string) => `? ${path}\0`;

describe("parsePorcelain", () => {
  test("plain modified / added / untracked, with the letters in the short format's spelling", () => {
    expect(parsePorcelain(changed(".M", "src/a.ts") + changed("A.", "src/b.ts") + untracked("src/c.ts"))).toEqual({
      files: [
        { xy: " M", path: "src/a.ts" },
        { xy: "A ", path: "src/b.ts" },
        { xy: "??", path: "src/c.ts" },
      ],
    });
  });
  test("renames report the new path, not the old one", () => {
    expect(parsePorcelain(renamed("R.", "new.ts", "old.ts")).files).toEqual([{ xy: "R ", path: "new.ts" }]);
    expect(parsePorcelain(renamed("RM", "new/dir/b.ts", "old/dir/a.ts") + changed(".M", "c.ts")).files).toEqual([
      { xy: "RM", path: "new/dir/b.ts" },
      { xy: " M", path: "c.ts" },
    ]);
    // an old path that reads like a record is still the old path
    expect(parsePorcelain(renamed("R.", "new.ts", "? old.ts") + untracked("c.ts")).files).toEqual([
      { xy: "R ", path: "new.ts" },
      { xy: "??", path: "c.ts" },
    ]);
  });
  test("a path is taken whole: an arrow, a space, a quote, a newline", () => {
    expect(
      parsePorcelain(
        changed(".M", "notes/a -> b.md") +
          unmerged("UU", "both sides.ts") +
          untracked("with space.ts") +
          untracked('a"b\nc.ts'),
      ).files,
    ).toEqual([
      { xy: " M", path: "notes/a -> b.md" },
      { xy: "UU", path: "both sides.ts" },
      { xy: "??", path: "with space.ts" },
      { xy: "??", path: 'a"b\nc.ts' },
    ]);
  });
  test("the branch header gives the commit and the branch", () => {
    const sha = "883a31386286e1ee8786b1362a15a85c17c0a9df";
    const upstream = "# branch.upstream origin/main\0# branch.ab +? -?\0";
    expect(parsePorcelain(`# branch.oid ${sha}\0# branch.head feat/x\0${upstream}${untracked("a.ts")}`)).toEqual({
      files: [{ xy: "??", path: "a.ts" }],
      head: sha,
      branch: "feat/x",
    });
    // no branch checked out
    expect(parsePorcelain(`# branch.oid ${sha}\0# branch.head (detached)\0`)).toEqual({ files: [], head: sha });
    // no commit yet: the branch has a name and nothing to point at
    expect(parsePorcelain("# branch.oid (initial)\0# branch.head main\0")).toEqual({ files: [], branch: "main" });
  });
  test("empty output, and a record cut short", () => {
    expect(parsePorcelain("")).toEqual({ files: [] });
    expect(parsePorcelain("1 .M N... 100644\0")).toEqual({ files: [] });
  });
});

describe("foldDropped", () => {
  test("a path listed as deleted and untracked is one modified entry", () => {
    const { files } = parsePorcelain(
      changed("D.", "a.ts") + changed(".M", "b.ts") + untracked("a.ts") + untracked("c.ts"),
    );
    expect(foldDropped(files)).toEqual({
      files: [
        { xy: " M", path: "a.ts" },
        { xy: " M", path: "b.ts" },
        { xy: "??", path: "c.ts" },
      ],
      dropped: ["a.ts"],
    });
  });
  test("a deletion on its own, or an untracked file on its own, is left as it is", () => {
    const { files } = parsePorcelain(changed("D.", "a.ts") + untracked("b.ts"));
    expect(foldDropped(files)).toEqual({ files, dropped: [] });
  });
});

describe("where HEAD stands, from the status call", () => {
  const { repo, cleanup } = tmpRepo();
  afterAll(cleanup);

  test("a branch checked out: its name and its commit, with the entries", async () => {
    sh(repo, GIT, "checkout", "-q", "-b", "feat/x");
    writeFileSync(join(repo, "new file.txt"), "one\n");
    const read = await statusEntries(repo);
    expect(read.head).toBe(sh(repo, GIT, "rev-parse", "HEAD"));
    expect(read.branch).toBe("feat/x");
    expect(read.files).toEqual([{ xy: "??", path: "new file.txt" }]);
  });

  test("a detached head: the commit and no branch", async () => {
    sh(repo, GIT, "checkout", "-q", "--detach");
    const read = await statusEntries(repo);
    expect(read.head).toBe(sh(repo, GIT, "rev-parse", "HEAD"));
    expect(read.branch).toBeUndefined();
    expect(read.files).toEqual([{ xy: "??", path: "new file.txt" }]);
  });

  test("a repo with no commits: the branch and no commit", async () => {
    const empty = join(dirname(repo), "empty");
    sh(dirname(repo), GIT, "init", "-q", "-b", "trunk", empty);
    writeFileSync(join(empty, "a.txt"), "one\n");
    sh(empty, GIT, "add", "a.txt");
    writeFileSync(join(empty, "b.txt"), "two\n");
    const read = await statusEntries(empty);
    expect(read.head).toBeUndefined();
    expect(read.branch).toBe("trunk");
    expect(read.files).toEqual([
      { xy: "A ", path: "a.txt" },
      { xy: "??", path: "b.txt" },
    ]);
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

describe("untracked files, each by its own path", () => {
  // what `-uall` says, which is the list every reader here is owed
  const everyFile = (repo: string) =>
    foldDropped(parsePorcelain(sh(repo, GIT, "status", "--porcelain=v2", "-z", "-uall")).files).files;
  const listed = async (repo: string) => (await statusFiles(repo)).map(({ xy, path }) => ({ xy, path }));

  /** a tree with every kind of untracked directory in it */
  function messy(mode?: string): { repo: string; cleanup: () => void } {
    const { repo, cleanup } = tmpRepo();
    if (mode) sh(repo, GIT, "config", "status.showUntrackedFiles", mode);
    const put = (path: string, body = "one\n") => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), body);
    };
    put("src/tracked.ts");
    put("only/one.txt");
    sh(repo, GIT, "add", "-A");
    sh(repo, GIT, "commit", "-q", "-m", "tree");
    put("loose.txt");
    // beside a tracked file: git lists it by name in either mode
    put("src/new.ts");
    put("new dir/a.txt");
    put("new dir/sub/b.txt");
    // a name that is pathspec magic and a glob when it is not taken literally
    put(":odd*[dir]/z.txt");
    put("café/é.txt");
    // an ignored file inside an untracked directory stays out
    put("ign/.gitignore", "*.log\n");
    put("ign/a.log");
    // a repository inside the tree is one entry, at the top or inside an untracked directory
    sh(repo, GIT, "init", "-q", join(repo, "nested"));
    put("nested/in.txt");
    sh(repo, GIT, "init", "-q", join(repo, "new dir", "vendored"));
    put("new dir/vendored/in.txt");
    // the index dropped the only file of a directory, which is then wholly untracked
    sh(repo, GIT, "rm", "-q", "--cached", "only/one.txt");
    put("only/one.txt", "one\ntwo\n");
    return { repo, cleanup };
  }

  for (const mode of [undefined, "normal", "all", "no"]) {
    test(`reads every file whatever the repo shows by default (${mode ?? "unset"})`, async () => {
      const { repo, cleanup } = messy(mode);
      try {
        const files = await listed(repo);
        expect(files).toEqual(everyFile(repo));
        expect(files).toContainEqual({ xy: "??", path: "new dir/sub/b.txt" });
        expect(files).toContainEqual({ xy: "??", path: "new dir/vendored/" });
        expect(files).toContainEqual({ xy: " M", path: "only/one.txt" });
        // the fingerprint a read hands over is the one taken without it
        expect(await treeFingerprint(repo, await statusEntries(repo))).toBe(await treeFingerprint(repo));
      } finally {
        cleanup();
      }
    });
  }

  test("more untracked directories than one command line should carry", async () => {
    const { repo, cleanup } = tmpRepo();
    try {
      for (let i = 0; i < 120; i++) {
        mkdirSync(join(repo, `d${i}`, "in"), { recursive: true });
        writeFileSync(join(repo, `d${i}`, "in", "f.txt"), "one\n");
      }
      writeFileSync(join(repo, "README.md"), "changed\n");
      const files = await listed(repo);
      expect(files).toHaveLength(121);
      expect(files).toEqual(everyFile(repo));
    } finally {
      cleanup();
    }
  });

  // git reports how it walked the tree, and names the cache's own counters only when the cache
  // answered: a request in a mode the cache is not kept in walks every directory without it
  for (const mode of [undefined, "all"]) {
    test(`a whole-tree read is answered from git's untracked cache (${mode ?? "unset"})`, async () => {
      const { repo, cleanup } = messy(mode);
      const trace = join(dirname(repo), "trace.txt");
      try {
        sh(repo, GIT, "config", "core.untrackedCache", "true");
        // the person's own status, which is what saves the cache
        sh(repo, GIT, "status");
        process.env.GIT_TRACE2_PERF = trace;
        await statusEntries(repo);
        delete process.env.GIT_TRACE2_PERF;
        expect(readFileSync(trace, "utf8")).toMatch(/read_directo.*opendir/);
      } finally {
        delete process.env.GIT_TRACE2_PERF;
        cleanup();
      }
    });
  }
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

describe("aheadBehind", () => {
  const { repo, cleanup } = tmpRepo();
  afterAll(cleanup);
  const commit = (file: string, subject: string) => {
    writeFileSync(join(repo, file), `${subject}\n`);
    sh(repo, GIT, "add", "-A");
    sh(repo, GIT, "commit", "-q", "-m", subject);
  };

  test("a commit main holds under another sha is not ahead; one main lacks is", async () => {
    sh(repo, GIT, "checkout", "-q", "-b", "feat");
    commit("a.txt", "one");
    commit("b.txt", "two");
    expect(await aheadBehind(repo, "main")).toEqual({ ahead: 2, behind: 0 });
    // main moves on its own, then takes both changes as new commits: the branch's shas are
    // nowhere on main, and its work is
    sh(repo, GIT, "checkout", "-q", "main");
    commit("c.txt", "elsewhere");
    sh(repo, GIT, "cherry-pick", "feat~1", "feat");
    sh(repo, GIT, "checkout", "-q", "feat");
    expect(sh(repo, GIT, "rev-list", "--count", "main..HEAD")).toBe("2");
    expect(await aheadBehind(repo, "main")).toEqual({ ahead: 0, behind: 3 });
    commit("d.txt", "three");
    expect(await aheadBehind(repo, "main")).toEqual({ ahead: 1, behind: 3 });
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
