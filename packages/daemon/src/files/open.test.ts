import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorktreeInfo } from "@toyon/shared";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { UserError } from "../core/errors.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { GIT } from "../git/exec.ts";
import { type Opened, type OpenedOutside, OpenService, PENDING_MS } from "./open.ts";

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
  const emitted: OpenedOutside[] = [];
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
    refused: [t.paths.stateFile, t.paths.tokenFile],
    now: () => now,
  });
  const root = dirname(t.repo);
  const outside = (name: string, content: string | Uint8Array) => {
    const p = join(root, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  };
  return {
    t,
    state,
    hub,
    opens,
    registered,
    found,
    emitted,
    refusals,
    root,
    outside,
    tick: (ms: number) => (now += ms),
  };
}

describe("what a path opens as", () => {
  test("a git repo registers, and is not held for a shell", async () => {
    const { t, opens, registered, emitted } = setup();
    expect(await opens.open(t.repo)).toEqual({ kind: "repo", repoId: "r1", delivered: false });
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
      delivered: false,
    });
    expect(await opens.open(join(t.repo, "src", "a.ts"))).toEqual({
      kind: "file",
      worktreeId: "wmain",
      path: "src/a.ts",
      delivered: false,
    });
    expect(emitted.map((o) => o.kind)).toEqual(["file", "file"]);
  });

  test("a symlink into a worktree is the worktree's file; a tilde is the home", async () => {
    const { t, opens, root } = setup();
    symlinkSync(join(t.repo, "README.md"), join(root, "link.md"));
    expect(await opens.open(join(root, "link.md"))).toMatchObject({
      kind: "file",
      worktreeId: "wmain",
      path: "README.md",
    });
  });

  test("a found worktree counts, and the deepest root wins", async () => {
    const { t, opens, found, root } = setup();
    const nested = join(t.repo, "nested");
    sh(t.repo, GIT, "worktree", "add", "-q", nested, "-b", "nested");
    found.push({ id: "disc-1", path: nested });
    expect(await opens.open(join(nested, "README.md"))).toMatchObject({
      kind: "file",
      worktreeId: "disc-1",
      path: "README.md",
    });
    const other = join(root, "other");
    sh(t.repo, GIT, "worktree", "add", "-q", other, "-b", "other");
    found.push({ id: "disc-2", path: other });
    expect(await opens.open(join(other, "README.md"))).toMatchObject({
      kind: "file",
      worktreeId: "disc-2",
      path: "README.md",
    });
  });

  test("a file asked for by a shell is answered to it alone: nothing emitted, nothing waiting", async () => {
    const { t, opens, outside, emitted, refusals, root } = setup();
    expect(await opens.file(join(t.repo, "README.md"))).toEqual({
      kind: "file",
      worktreeId: "wmain",
      path: "README.md",
    });
    const p = outside("shot/notes.md", "hi\n");
    expect(await opens.file(p)).toMatchObject({ kind: "loose", name: "notes.md", text: "hi\n" });
    expect(emitted).toEqual([]);
    expect(opens.takePending()).toEqual([]);
    // a folder is refused even when it is a repo: the shell asked for a file, and the refusal is
    // the reply, not a broadcast
    await expect(opens.file(t.repo)).rejects.toThrow("is a folder");
    await expect(opens.file(join(root, "gone.md"))).rejects.toThrow("does not exist");
    expect(refusals).toEqual([]);
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
    expect(emitted.map((e) => (e.kind === "loose" ? e.id : e.kind))).toEqual([o.id]);
  });

  test("a binary is granted empty and marked; a picture or clip is served by its grant, anything else is not", async () => {
    const { opens, outside, refusals } = setup();
    const bin = outside("pic.bin", new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
    const o = (await opens.open(bin)) as Extract<Opened, { kind: "loose" }>;
    expect(o).toMatchObject({ kind: "loose", name: "pic.bin", text: "", binary: true, tooLarge: false });
    expect(opens.viewable(o.id)).toBeNull();
    const png = outside("shot.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const p = (await opens.open(png)) as Extract<Opened, { kind: "loose" }>;
    expect(p.binary).toBe(true);
    expect(opens.viewable(p.id)).toBe(realpathSync(png));
    const mp4 = outside("clip.mp4", new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
    const v = (await opens.open(mp4)) as Extract<Opened, { kind: "loose" }>;
    expect(v.binary).toBe(true);
    expect(opens.viewable(v.id)).toBe(realpathSync(mp4));
    const md = outside("plain.md", "# hi\n");
    const m = (await opens.open(md)) as Extract<Opened, { kind: "loose" }>;
    expect(m.binary).toBe(false);
    expect(opens.viewable(m.id)).toBeNull();
    expect(opens.viewable("never")).toBeNull();
    expect(refusals).toEqual([]);
  });

  test("the daemon's own state is refused by file, and the rest of its home opens", async () => {
    const { t, opens, refusals } = setup();
    writeFileSync(t.paths.stateFile, "{}");
    await expect(opens.open(t.paths.stateFile)).rejects.toThrow(UserError);
    expect(refusals).toEqual(["state.json is Toyon's own state, which the daemon keeps itself"]);
    // a symlink out of the home to a granted place is still the daemon's file
    symlinkSync(t.paths.stateFile, join(t.paths.home, "..", "aside.json"));
    await expect(opens.open(join(t.paths.home, "..", "aside.json"))).rejects.toThrow(UserError);
    // a transcript sits in the same home and is the person's to read
    mkdirSync(t.paths.transcriptsDir, { recursive: true });
    const transcript = join(t.paths.transcriptsDir, "abc.jsonl");
    writeFileSync(transcript, '{"t":"turn-start"}\n');
    const o = await opens.open(transcript);
    expect(o).toMatchObject({ kind: "loose", name: "abc.jsonl", text: '{"t":"turn-start"}\n' });
    expect(refusals).toHaveLength(2);
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

  test("a shell told at once leaves nothing waiting, and the reply says the shell has it", async () => {
    const { opens, outside, hub } = setup();
    // with no shell up the launcher is told so, and goes on to open the window the file waits for
    expect((await opens.open(outside("a.md", "a"))).delivered).toBe(false);
    opens.delivered();
    expect(opens.takePending()).toEqual([]);
    // the socket server answers the emit in the same tick when a shell is connected
    hub.on("opened", () => opens.delivered());
    expect((await opens.open(outside("b.md", "b"))).delivered).toBe(true);
    expect(opens.takePending()).toEqual([]);
  });
});

describe("a git URL from outside", () => {
  test("is held for a shell as the repository to clone into the folder given, nothing cloned", async () => {
    const { opens, emitted, root } = setup();
    expect((await opens.clone("https://github.com/x/y/tree/dev", root)).delivered).toBe(false);
    const want: OpenedOutside = {
      kind: "clone",
      url: "https://github.com/x/y",
      name: "y",
      branch: "dev",
      parent: realpathSync(root),
    };
    expect(emitted).toEqual([want]);
    expect(opens.takePending()).toEqual([want]);
    expect(existsSync(join(root, "y"))).toBe(false);
  });

  test("refuses now what the view would refuse on return, in words a shell says too", async () => {
    const { opens, refusals, root } = setup();
    await expect(opens.clone("not a url", root)).rejects.toBeInstanceOf(UserError);
    await expect(opens.clone("https://github.com/x/y", join(root, "missing"))).rejects.toBeInstanceOf(UserError);
    mkdirSync(join(root, "y"));
    await expect(opens.clone("https://github.com/x/y", root)).rejects.toThrow(/already exists/);
    expect(refusals).toHaveLength(3);
    expect(opens.takePending()).toEqual([]);
  });
});

describe("where a path sits, for a Finder reveal", () => {
  test("a file or a folder anywhere that exists, with nothing granted; a missing one is refused in words", async () => {
    const { t, opens, outside, root } = setup();
    const file = outside("notes/a.md", "a");
    expect(await opens.where(file)).toBe(realpathSync(file));
    expect(await opens.where(join(root, "notes"))).toBe(realpathSync(join(root, "notes")));
    // under the daemon's home too: a reveal reads nothing, so there is nothing to keep from it
    const home = join(t.paths.home, "state.json");
    writeFileSync(home, "{}");
    expect(await opens.where(home)).toBe(realpathSync(home));
    expect(opens.takePending()).toEqual([]);
    await expect(opens.where(join(root, "gone.md"))).rejects.toBeInstanceOf(UserError);
  });
});
