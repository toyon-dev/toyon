import { describe, expect, test } from "bun:test";
import type { GitFileStatus } from "@toyon/shared";
import type { DaemonSocket } from "../../ws.ts";
import { type Action, EMPTY_LOCAL, type WorktreeLocal } from "../store.ts";
import { listFiles, listingKey } from "./file.ts";

describe("listingKey", () => {
  const head = "abc123";

  test("editing files that exist leaves the key alone", () => {
    const before = listingKey(head, [{ path: "a.ts", xy: " M", add: 1 }]);
    const after = listingKey(head, [
      { path: "a.ts", xy: " M", add: 9 },
      { path: "b.ts", xy: "M ", add: 2 },
    ]);
    expect(after).toBe(before);
  });

  test("a file added or deleted changes it, and staging an added file does not", () => {
    const clean = listingKey(head, []);
    const added = listingKey(head, [{ path: "new.ts", xy: "??" }]);
    expect(added).not.toBe(clean);
    expect(listingKey(head, [{ path: "new.ts", xy: "A " }])).toBe(added);
    expect(listingKey(head, [{ path: "old.ts", xy: " D" }])).not.toBe(clean);
  });

  test("a new commit changes it even when the status is clean", () => {
    expect(listingKey("def456", [])).not.toBe(listingKey(head, []));
  });
});

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
  const git = (head: string, files: GitFileStatus[] = []) => ({ files, head });

  test("asks once per key: the request is remembered on the record, and the same key asks nothing", () => {
    const { sent, actions, deps, at } = make();
    listFiles("w1", at({ git: git("h1") }), deps);
    expect(sent).toEqual([{ t: "list-files", worktreeId: "w1" }]);
    expect(actions).toEqual([{ a: "files-asked", worktreeId: "w1", key: listingKey("h1", []) }]);
    listFiles("w1", at({ git: git("h1"), filesFor: listingKey("h1", []) }), deps);
    expect(sent).toHaveLength(1);
  });

  test("a file the status says is new, or a new commit, asks again", () => {
    const { sent, deps, at } = make();
    const asked = listingKey("h1", []);
    listFiles("w1", at({ git: git("h1", [{ path: "n.ts", xy: "??" }]), filesFor: asked }), deps);
    listFiles("w1", at({ git: git("h2"), filesFor: asked }), deps);
    expect(sent).toHaveLength(2);
  });

  test("with no socket nothing is asked or remembered", () => {
    const { sent, actions, deps, at } = make();
    listFiles("w1", at({}), { ...deps, sock: null });
    expect(sent).toEqual([]);
    expect(actions).toEqual([]);
  });
});
