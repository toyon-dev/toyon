import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { StateStore } from "../core/state.ts";
import { GIT } from "../git/exec.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import type { ReadableWorktree } from "../worktrees/service.ts";
import { FileService, parseGrepRow, SEARCH_MAX, SEARCH_PER_FILE } from "./service.ts";

let cleanup = () => {};
afterEach(() => cleanup());

function setup() {
  const t = tmpRepo();
  cleanup = t.cleanup;
  const wt: ReadableWorktree = {
    id: "w1",
    repoId: "r1",
    path: t.repo,
    name: "repo",
    branch: "main",
    defaultBranch: "main",
    base: "main",
  };
  const files = new FileService(new StateStore(t.paths), {} as RuntimeRegistry, (id) => (id === "w1" ? wt : null));
  const write = (rel: string, text: string) => {
    mkdirSync(join(t.repo, rel, ".."), { recursive: true });
    writeFileSync(join(t.repo, rel), text);
  };
  return { ...t, files, write, commit: () => sh(t.repo, GIT, "add", "-A") && sh(t.repo, GIT, "commit", "-qm", "x") };
}

describe("parseGrepRow", () => {
  test("reads path, line and text off a -z row, and refuses anything else", () => {
    const row = ["a:b.ts", "12", "  const x = 1;  "].join("\0");
    expect(parseGrepRow(row)).toEqual({ path: "a:b.ts", line: 12, text: "const x = 1;" });
    expect(parseGrepRow("no separators")).toBeNull();
    expect(parseGrepRow(["path", "notanumber", "text"].join("\0"))).toBeNull();
  });
});

describe("FileService.search", () => {
  test("finds tracked and untracked files, not ignored ones, with the path verbatim", async () => {
    const s = setup();
    s.write("src/a:b.ts", "needle one\n");
    s.write("src/ä.ts", "x\nNEEDLE two\n");
    s.commit();
    s.write("untracked.ts", "needle three\n");
    s.write(".gitignore", "out/\n");
    s.write("out/built.js", "needle four\n");
    const page = await s.files.search("w1", "needle", {});
    expect(page?.truncated).toBe(false);
    expect(page?.hits).toEqual([
      { path: "src/a:b.ts", line: 1, text: "needle one" },
      { path: "src/ä.ts", line: 2, text: "NEEDLE two" },
      { path: "untracked.ts", line: 1, text: "needle three" },
    ]);
  });

  test("a file gets its share of the page and no more, and the page says so", async () => {
    const s = setup();
    s.write("a.lock", "needle\n".repeat(SEARCH_PER_FILE + 5));
    s.write("b.ts", "needle\n");
    s.commit();
    const page = await s.files.search("w1", "needle", {});
    expect(page?.truncated).toBe(true);
    expect(page?.hits.filter((h) => h.path === "a.lock")).toHaveLength(SEARCH_PER_FILE);
    expect(page?.hits.at(-1)).toEqual({ path: "b.ts", line: 1, text: "needle" });
  });

  test("a file at exactly its share is not called truncated", async () => {
    const s = setup();
    s.write("a.ts", "needle\n".repeat(SEARCH_PER_FILE));
    s.commit();
    const page = await s.files.search("w1", "needle", {});
    expect(page?.truncated).toBe(false);
    expect(page?.hits).toHaveLength(SEARCH_PER_FILE);
  });

  test("the page fills at SEARCH_MAX and git is stopped there", async () => {
    const s = setup();
    for (let i = 0; i < SEARCH_MAX / 10 + 2; i++) s.write(`f${String(i).padStart(3, "0")}.ts`, "needle\n".repeat(10));
    s.commit();
    const page = await s.files.search("w1", "needle", {});
    expect(page?.truncated).toBe(true);
    expect(page?.hits).toHaveLength(SEARCH_MAX);
  });

  test("a line longer than the row cap is cut, and the file after it still shows", async () => {
    const s = setup();
    s.write("a.min.js", `${"x".repeat(100_000)}needle${"y".repeat(100_000)}\n`);
    s.write("b.ts", "needle\n");
    s.commit();
    const page = await s.files.search("w1", "needle", {});
    expect(page?.hits.map((h) => h.path)).toEqual(["a.min.js", "b.ts"]);
    expect(page?.hits[0]?.text.length).toBe(200);
  });

  test("the next query from the same socket stops the one running, which answers nothing", async () => {
    const s = setup();
    s.write("a.ts", "needle\n");
    s.commit();
    const socket = {};
    const first = s.files.search("w1", "needle", socket);
    const second = s.files.search("w1", "needle", socket);
    expect(await first).toBeNull();
    expect((await second)?.hits).toHaveLength(1);
  });

  test("stopSearch ends the search for that socket alone", async () => {
    const s = setup();
    s.write("a.ts", "needle\n");
    s.commit();
    const mine = {};
    const theirs = {};
    const a = s.files.search("w1", "needle", mine);
    const b = s.files.search("w1", "needle", theirs);
    s.files.stopSearch(mine);
    expect(await a).toBeNull();
    expect((await b)?.hits).toHaveLength(1);
  });

  test("a query under two characters answers an empty page without running git", async () => {
    const s = setup();
    expect(await s.files.search("w1", " n ", {})).toEqual({ hits: [], truncated: false });
  });
});
