import { describe, expect, test } from "bun:test";
import { diskKey, type GitFileStatus, indexKey } from "@toyon/shared";
import type { DaemonSocket } from "../../ws.ts";
import { type Action, EMPTY_LOCAL, type WorktreeLocal } from "../store.ts";
import { createFile, discardQuestion, listFiles, settleCreate } from "./file.ts";

describe("listFiles", () => {
  const make = () => {
    const sent: unknown[] = [];
    const actions: Action[] = [];
    const deps = {
      sock: { send: (m: unknown) => sent.push(m) } as unknown as DaemonSocket,
      dispatch: (a: Action) => actions.push(a),
    };
    const at = (l: Partial<WorktreeLocal>) => ({ local: { w1: { ...EMPTY_LOCAL, ...l } } });
    return { sent, actions, deps, at };
  };
  const git = (head: string, files: GitFileStatus[] = []) => ({ version: 1, files, head });
  const asked = (head: string, files: GitFileStatus[] = []) => ({ index: indexKey(head, files), disk: diskKey(files) });

  test("asks once per pair of keys: the ask is remembered on the record, and the same pair asks nothing", () => {
    const { sent, actions, deps, at } = make();
    listFiles("w1", at({ git: git("h1") }), deps);
    expect(sent).toEqual([{ t: "list-files", worktreeId: "w1", tracked: true }]);
    expect(actions).toEqual([{ a: "files-asked", worktreeId: "w1", ...asked("h1") }]);
    listFiles("w1", at({ git: git("h1"), filesFor: asked("h1") }), deps);
    expect(sent).toHaveLength(1);
  });

  test("an edit to a file that exists asks nothing", () => {
    const { sent, deps, at } = make();
    const edited: GitFileStatus[] = [
      { path: "a.ts", xy: " M", add: 9 },
      { path: "b.ts", xy: "M ", add: 2 },
    ];
    listFiles("w1", at({ git: git("h1", edited), filesFor: asked("h1") }), deps);
    expect(sent).toEqual([]);
  });

  test("a file that is new or gone walks what git ignores again, and leaves the index alone", () => {
    const { sent, deps, at } = make();
    listFiles("w1", at({ git: git("h1", [{ path: "n.ts", xy: "??" }]), filesFor: asked("h1") }), deps);
    listFiles("w1", at({ git: git("h1", [{ path: "old.ts", xy: " D" }]), filesFor: asked("h1") }), deps);
    expect(sent).toEqual([
      { t: "list-files", worktreeId: "w1", tracked: false },
      { t: "list-files", worktreeId: "w1", tracked: false },
    ]);
  });

  test("a new commit, or a path staged in or out of the index, reads the index again", () => {
    const { sent, deps, at } = make();
    listFiles("w1", at({ git: git("h2"), filesFor: asked("h1") }), deps);
    listFiles("w1", at({ git: git("h1", [{ path: "n.ts", xy: "A " }]), filesFor: asked("h1") }), deps);
    listFiles("w1", at({ git: git("h1", [{ path: "old.ts", xy: "D " }]), filesFor: asked("h1") }), deps);
    expect(sent).toHaveLength(3);
    expect(sent.every((m) => (m as { tracked: boolean }).tracked)).toBe(true);
  });

  test("with no socket nothing is asked or remembered", () => {
    const { sent, actions, deps, at } = make();
    listFiles("w1", at({}), { ...deps, sock: null });
    expect(sent).toEqual([]);
    expect(actions).toEqual([]);
  });
});

describe("createFile", () => {
  const make = () => {
    const sent: Array<{ t: string; seq: number }> = [];
    const actions: Action[] = [];
    const deps = {
      sock: { send: (m: { t: string; seq: number }) => sent.push(m) } as unknown as DaemonSocket,
      dispatch: (a: Action) => actions.push(a),
    };
    return { sent, actions, deps };
  };
  type Written = Parameters<typeof settleCreate>[0];
  const answer = (seq: number, rest: object): Written =>
    ({ t: "file-written", worktreeId: "w1", path: "src/a.ts", seq, ...rest }) as Written;

  test("sends an empty write with no base, and opens the file once it is made", async () => {
    const { sent, actions, deps } = make();
    const made = createFile(deps, { worktreeId: "w1", path: "src/a.ts" });
    expect(sent[0]).toMatchObject({ t: "write-file", worktreeId: "w1", path: "src/a.ts", content: "", base: null });
    expect(settleCreate(answer(sent[0]!.seq, { ok: true, version: "v1" }))).toBe(true);
    expect(await made).toBeNull();
    expect(actions).toMatchObject([
      { a: "open-file", v: { worktreeId: "w1", path: "src/a.ts", view: "file", focus: true } },
    ]);
  });

  test("a file already there, or a refusal, comes back as the reason and opens nothing", async () => {
    const { sent, actions, deps } = make();
    const there = createFile(deps, { worktreeId: "w1", path: "src/a.ts" });
    settleCreate(answer(sent[0]!.seq, { ok: false, reason: "changed", version: "v9" }));
    expect(await there).toBe("a file is already there");
    const refused = createFile(deps, { worktreeId: "w1", path: "src/a.ts" });
    settleCreate(
      answer(sent[1]!.seq, { ok: false, reason: "refused", version: null, message: "path escapes worktree" }),
    );
    expect(await refused).toBe("path escapes worktree");
    expect(actions).toEqual([]);
  });

  test("an answer to a write nobody made here is left for the open file's sync", () => {
    expect(settleCreate(answer(999_999, { ok: true, version: "v1" }))).toBe(false);
  });
});

describe("discardQuestion", () => {
  test("one file is named", () => {
    expect(discardQuestion(["src/a.ts"])).toBe("Discard uncommitted changes to src/a.ts?");
  });

  test("several are counted and listed", () => {
    expect(discardQuestion(["a.ts", "b.ts"])).toBe("Discard uncommitted changes to 2 files?\n\na.ts\nb.ts");
  });

  test("past a screenful the rest is a count", () => {
    const paths = Array.from({ length: 15 }, (_, i) => `f${i}.ts`);
    const q = discardQuestion(paths);
    expect(q.startsWith("Discard uncommitted changes to 15 files?\n\nf0.ts\n")).toBe(true);
    expect(q.endsWith("f11.ts\nand 3 more")).toBe(true);
    expect(q).not.toContain("f12.ts");
  });
});
