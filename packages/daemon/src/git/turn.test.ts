import { afterAll, describe, expect, test } from "bun:test";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT, run } from "./exec.ts";
import { fileAt, filesBetween, statusFiles } from "./status.ts";
import { dropTurnRefs, markTurn, turnChanges } from "./turn.ts";

// Real git in a temp repo: a branch off main stands in for a worktree, since the refs and the
// index the snapshots use are the same in either.

function branchRepo() {
  const made = tmpRepo();
  sh(made.repo, GIT, "checkout", "-q", "-b", "work");
  const write = (name: string, text: string) => writeFileSync(join(made.repo, name), text);
  const paths = async () =>
    (await turnChanges(made.repo, "w", "main", true))?.files.map((f) => `${f.xy.trim()} ${f.path}`);
  return { ...made, write, paths };
}

describe("turnChanges", () => {
  const { repo, cleanup, write, paths } = branchRepo();
  afterAll(cleanup);

  test("nothing to say before any send, or while the first turn is the whole of the work", async () => {
    expect(await turnChanges(repo, "w", "main", true)).toBeNull();
    await markTurn(repo, "w");
    write("a.txt", "one\n");
    // the tree the turn started from is HEAD's: the uncommitted list is already exactly this
    expect(await turnChanges(repo, "w", "main", true)).toBeNull();
  });

  test("the second turn's files alone, with its own counts, untracked files included", async () => {
    await markTurn(repo, "w");
    write("a.txt", "one\ntwo\n");
    write("b.txt", "new\n");
    const turn = await turnChanges(repo, "w", "main", true);
    expect(turn?.files).toEqual([
      { xy: "M ", path: "a.txt", add: 1, del: 0 },
      { xy: "A ", path: "b.txt", add: 1, del: 0 },
    ]);
    // the before side of a row's diff is the file as the turn found it
    expect(await fileAt(repo, turn!.base, "a.txt")).toBe("one\n");
    // the person's staging area was never touched
    expect(sh(repo, GIT, "diff", "--cached", "--name-only")).toBe("");
  });

  test("a turn that writes nothing leaves the one before it showing", async () => {
    await markTurn(repo, "w");
    expect(await paths()).toEqual(["M a.txt", "A b.txt"]);
    // and so does a second send over the same tree
    await markTurn(repo, "w");
    expect(await paths()).toEqual(["M a.txt", "A b.txt"]);
  });

  test("once the running turn writes, the section is that turn's", async () => {
    write("c.txt", "three\n");
    expect(await paths()).toEqual(["A c.txt"]);
    // a file put back as the turn found it leaves the section
    rmSync(join(repo, "c.txt"));
    expect(await paths()).toEqual(["M a.txt", "A b.txt"]);
  });

  test("a commit on the branch does not end it; taking main in does", async () => {
    write("c.txt", "three\n");
    await markTurn(repo, "w");
    write("d.txt", "four\n");
    sh(repo, GIT, "add", "a.txt");
    sh(repo, GIT, "commit", "-q", "-m", "part");
    expect(await paths()).toEqual(["A d.txt"]);
    sh(repo, GIT, "stash", "-q", "-u");
    sh(repo, GIT, "checkout", "-q", "main");
    writeFileSync(join(repo, "theirs.txt"), "x\n");
    sh(repo, GIT, "add", "-A");
    sh(repo, GIT, "commit", "-q", "-m", "theirs");
    sh(repo, GIT, "checkout", "-q", "work");
    sh(repo, GIT, "rebase", "-q", "main");
    sh(repo, GIT, "stash", "pop", "-q");
    // the difference would now hold main's work as well as the turn's
    expect(await turnChanges(repo, "w", "main", true)).toBeNull();
  });

  test("a scratch index git cannot read is started again", async () => {
    const index = join(sh(repo, GIT, "rev-parse", "--absolute-git-dir"), "toyon-turn-index");
    writeFileSync(index, "not an index");
    await markTurn(repo, "w");
    write("g.txt", "seven\n");
    expect(await paths()).toEqual(["A g.txt"]);
    rmSync(join(repo, "g.txt"));
  });

  test("dropped refs leave nothing to read", async () => {
    await markTurn(repo, "w");
    write("e.txt", "five\n");
    await markTurn(repo, "w");
    write("f.txt", "six\n");
    expect(await paths()).toEqual(["A f.txt"]);
    await dropTurnRefs(repo, "w");
    expect(await turnChanges(repo, "w", "main", true)).toBeNull();
    expect(sh(repo, GIT, "for-each-ref", "refs/toyon/turns/")).toBe("");
  });
});

describe("turnChanges on the main checkout", () => {
  const { repo, cleanup } = tmpRepo();
  afterAll(cleanup);

  test("any move of HEAD ends it", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    await markTurn(repo, "m");
    writeFileSync(join(repo, "b.txt"), "two\n");
    expect((await turnChanges(repo, "m", "main", false))?.files.map((f) => f.path)).toEqual(["b.txt"]);
    sh(repo, GIT, "add", "a.txt");
    sh(repo, GIT, "commit", "-q", "-m", "a");
    expect(await turnChanges(repo, "m", "main", false)).toBeNull();
  });
});

// The reads between turns stage only the paths the status lists. Each is checked against the slow
// way: the same tree built from nothing in a throwaway index.
describe("turnChanges, given the status it rides with", () => {
  const { repo, cleanup, write } = branchRepo();
  afterAll(cleanup);
  const scratch = join(repo, "..", "oracle-index");

  async function agrees(): Promise<string[]> {
    const fast = await turnChanges(repo, "w", "main", true, await statusFiles(repo));
    const env = { GIT_INDEX_FILE: scratch };
    rmSync(scratch, { force: true });
    await run(GIT, ["read-tree", "HEAD"], repo, env);
    await run(GIT, ["add", "-A"], repo, env);
    const tree = (await run(GIT, ["write-tree"], repo, env)).out;
    expect(fast?.files ?? []).toEqual(fast ? await filesBetween(repo, fast.base, tree) : []);
    return (fast?.files ?? []).map((f) => `${f.xy.trim()} ${f.path}`);
  }

  test("edits, a file put back, an untracked file gone, a staged rename and a commit all read true", async () => {
    write("a.txt", "one\n");
    write("b.txt", "two\n");
    sh(repo, GIT, "add", "a.txt");
    sh(repo, GIT, "commit", "-q", "-m", "a");
    write("a.txt", "one\nmine\n");
    await markTurn(repo, "w");
    expect(await agrees()).toEqual([]);

    // the turn writes: a tracked file, a new one
    write("a.txt", "one\nmine\nturn\n");
    write("c.txt", "three\n");
    expect(await agrees()).toEqual(["M a.txt", "A c.txt"]);

    // a file dirty when the turn started goes back to HEAD's: the status no longer lists it
    write("a.txt", "one\n");
    expect(await agrees()).toEqual(["M a.txt", "A c.txt"]);

    // the untracked file the turn started with is deleted, and the one it made is too
    rmSync(join(repo, "b.txt"));
    rmSync(join(repo, "c.txt"));
    expect(await agrees()).toEqual(["M a.txt", "D b.txt"]);

    // a staged rename names only where the file went
    write("b.txt", "two\n");
    renameSync(join(repo, "a.txt"), join(repo, "moved.txt"));
    sh(repo, GIT, "add", "-A", "a.txt", "moved.txt");
    expect(await agrees()).toEqual(["D a.txt", "A moved.txt"]);

    // a commit moves HEAD under the same files
    sh(repo, GIT, "commit", "-q", "-m", "move");
    write("d.txt", "four\n");
    expect(await agrees()).toEqual(["D a.txt", "A d.txt", "A moved.txt"]);
  });
});
