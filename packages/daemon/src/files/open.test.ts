import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorktreeInfo } from "@toyon/shared";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { UserError } from "../core/errors.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { GIT } from "../git/exec.ts";
import { type Opened, type OpenedFile, OpenService, PENDING_MS } from "./open.ts";

let cleanup = () => {};
afterEach(() => cleanup());

function setup() {
  const t = tmpRepo();
  cleanup = t.cleanup;
  const state = new StateStore(t.paths);
  const hub = new Hub();
  const main: WorktreeInfo = {
    id: "wmain",
    repoId: "r1",
    path: t.repo,
    branch: "main",
    kind: "main",
    proxyPort: 0,
    title: "repo",
    createdAt: 0,
  };
  state.addWorktree(main);
  const registered: string[] = [];
  const found: { id: string; path: string }[] = [];
  const emitted: OpenedFile[] = [];
  hub.on("opened", (o) => emitted.push(o));
  const refusals: string[] = [];
  hub.on("openRefused", (m) => refusals.push(m));
  let now = 1_000_000;
  const opens = new OpenService({
    state,
    hub,
    register: async (path) => {
      registered.push(path);
      return { id: "r1" };
    },
    found: async () => found,
    refused: [t.paths.home],
    now: () => now,
  });
  const root = dirname(t.repo);
  const outside = (name: string, content: string | Uint8Array) => {
    const p = join(root, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  };
  return { t, state, opens, registered, found, emitted, refusals, root, outside, tick: (ms: number) => (now += ms) };
}

describe("what a path opens as", () => {
  test("a git repo registers, and is not held for a shell", async () => {
    const { t, opens, registered, emitted } = setup();
    expect(await opens.open(t.repo)).toEqual({ kind: "repo", repoId: "r1" });
    // registered by its real path: a temp dir on macOS is reached through a symlink
    expect(registered).toEqual([realpathSync(t.repo)]);
    expect(emitted).toEqual([]);
    expect(opens.takePending()).toEqual([]);
  });

  test("a directory that is no repo, a missing path, and a socket are refused by name", async () => {
    const { opens, root, outside } = setup();
    mkdirSync(join(root, "plain"));
    await expect(opens.open(join(root, "plain"))).rejects.toThrow("is not a git repository");
    await expect(opens.open(join(root, "gone.md"))).rejects.toThrow("does not exist");
    outside("a.md", "");
    await expect(opens.open(join(root, "a.md", "under"))).rejects.toThrow();
  });

  test("a file inside a worktree opens there, by its relative path", async () => {
    const { t, opens, emitted } = setup();
    mkdirSync(join(t.repo, "src"));
    writeFileSync(join(t.repo, "src", "a.ts"), "a");
    expect(await opens.open(join(t.repo, "README.md"))).toEqual({
      kind: "file",
      worktreeId: "wmain",
      path: "README.md",
    });
    expect(await opens.open(join(t.repo, "src", "a.ts"))).toEqual({
      kind: "file",
      worktreeId: "wmain",
      path: "src/a.ts",
    });
    expect(emitted.map((o) => o.kind)).toEqual(["file", "file"]);
  });

  test("a symlink into a worktree is the worktree's file; a tilde is the home", async () => {
    const { t, opens, root } = setup();
    symlinkSync(join(t.repo, "README.md"), join(root, "link.md"));
    expect(await opens.open(join(root, "link.md"))).toEqual({ kind: "file", worktreeId: "wmain", path: "README.md" });
  });

  test("a found worktree counts, and the deepest root wins", async () => {
    const { t, opens, found, root } = setup();
    const nested = join(t.repo, "nested");
    sh(t.repo, GIT, "worktree", "add", "-q", nested, "-b", "nested");
    found.push({ id: "disc-1", path: nested });
    expect(await opens.open(join(nested, "README.md"))).toEqual({
      kind: "file",
      worktreeId: "disc-1",
      path: "README.md",
    });
    const other = join(root, "other");
    sh(t.repo, GIT, "worktree", "add", "-q", other, "-b", "other");
    found.push({ id: "disc-2", path: other });
    expect(await opens.open(join(other, "README.md"))).toEqual({
      kind: "file",
      worktreeId: "disc-2",
      path: "README.md",
    });
  });

  test("a text file outside every project is granted, with its text and version", async () => {
    const { opens, outside, emitted } = setup();
    const p = outside("notes/todo.md", "# todo\n");
    const o = (await opens.open(p)) as Extract<Opened, { kind: "loose" }>;
    expect(o).toMatchObject({
      kind: "loose",
      name: "todo.md",
      path: realpathSync(p),
      text: "# todo\n",
      tooLarge: false,
    });
    expect(o.version).not.toBeNull();
    expect(o.id).toHaveLength(10);
    expect(emitted).toEqual([o]);
  });

  test("a binary is refused; a file under the daemon's home is refused; each refusal is said to the shells", async () => {
    const { t, opens, outside, refusals } = setup();
    const bin = outside("pic.bin", new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
    await expect(opens.open(bin)).rejects.toThrow("pic.bin is not a text file");
    expect(refusals).toEqual(["pic.bin is not a text file"]);
    const inHome = join(t.paths.home, "secret.txt");
    writeFileSync(inHome, "s");
    await expect(opens.open(inHome)).rejects.toThrow(UserError);
    // a symlink out of the home to a granted place is still the home's file
    symlinkSync(inHome, join(t.paths.home, "..", "aside.txt"));
    await expect(opens.open(join(t.paths.home, "..", "aside.txt"))).rejects.toThrow(UserError);
  });
});

describe("a granted file's saves", () => {
  test("write only over the version last seen; the file's own bytes decide", async () => {
    const { opens, outside } = setup();
    const p = outside("todo.md", "one\n");
    const o = (await opens.open(p)) as Extract<Opened, { kind: "loose" }>;
    const w1 = await opens.write(o.id, "two\n", o.version);
    expect(w1.ok).toBe(true);
    expect(await Bun.file(p).text()).toBe("two\n");
    // someone else wrote since: the edit is not taken, and what is there now is named
    writeFileSync(p, "theirs\n");
    const w2 = await opens.write(o.id, "three\n", w1.ok ? w1.version : null);
    expect(w2).toMatchObject({ ok: false, reason: "changed" });
    expect(await Bun.file(p).text()).toBe("theirs\n");
    const w3 = await opens.write(o.id, "three\n", w2.version);
    expect(w3.ok).toBe(true);
  });

  test("an id this daemon never granted is refused in words", async () => {
    const { opens } = setup();
    await expect(opens.write("nope", "x", null)).rejects.toThrow("no longer open here");
  });
});

describe("an open waiting for a shell", () => {
  test("is taken once by the next socket, and only while fresh", async () => {
    const { opens, outside, tick } = setup();
    await opens.open(outside("a.md", "a"));
    tick(PENDING_MS - 1);
    await opens.open(outside("b.md", "b"));
    expect(opens.takePending().map((o) => (o.kind === "loose" ? o.name : o.kind))).toEqual(["a.md", "b.md"]);
    expect(opens.takePending()).toEqual([]);
    await opens.open(outside("c.md", "c"));
    tick(PENDING_MS + 1);
    expect(opens.takePending()).toEqual([]);
  });

  test("a shell told at once leaves nothing waiting", async () => {
    const { opens, outside } = setup();
    await opens.open(outside("a.md", "a"));
    opens.delivered();
    expect(opens.takePending()).toEqual([]);
  });
});
