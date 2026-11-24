import { describe, expect, test } from "bun:test";
import type { ArchivedWorktree, OwnedWorktree, RepoInfo, WorktreeStatus } from "@toyon/shared";
import { peerKey, peerWorktree } from "./peer.ts";

const row = (
  id: string,
  repoId: string,
  title: string,
  opts: { kind?: "main" | "worktree" | "spare"; path?: string } = {},
): OwnedWorktree => {
  const path = opts.path ?? `/w/${repoId}/wt-${id.slice(0, 4)}`;
  return {
    id,
    repoId,
    path,
    worktree: { id, repoId, path, branch: `toyon/${id}`, kind: opts.kind ?? "worktree", title, createdAt: 5 },
  } as unknown as OwnedWorktree;
};

const gone = (id: string, repoId: string, title: string): ArchivedWorktree =>
  ({
    id,
    repoId,
    title,
    branch: `toyon/${id}`,
    path: `/w/${repoId}/wt-${id.slice(0, 4)}`,
    createdAt: 1,
    archivedAt: 2,
    restorable: true,
  }) as ArchivedWorktree;

const repos = [
  { id: "r1", name: "toyon" },
  { id: "r2", name: "site" },
  { id: "r3", name: "demo" },
] as RepoInfo[];

const state = (rows: WorktreeStatus[], archived: Record<string, ArchivedWorktree[]> = {}) => ({
  rows,
  archived,
  repos,
});

describe("peerWorktree", () => {
  const here = row("061e0f34bb", "r1", "Send message flash");
  const there = row("5426aa11bb", "r1", "Featured media");

  test("a session in a worktree of this project is that worktree", () => {
    const s = state([here, there]);
    expect(peerWorktree(s, "wt-5426-1f", here.id)).toEqual({ id: "5426aa11bb", title: "Featured media" });
  });

  test("a worktree of another project is named with its project", () => {
    const s = state([here, row("273e00cc11", "r2", "Hero copy")]);
    expect(peerWorktree(s, "wt-273e-4a", here.id)).toEqual({ id: "273e00cc11", title: "Hero copy", project: "site" });
  });

  test("the directory is matched whole", () => {
    const s = state([here, there]);
    // a longer directory that starts the same, the directory with no suffix, a session elsewhere
    expect(peerWorktree(s, "wt-5426a-1f", here.id)).toBeNull();
    expect(peerWorktree(s, "wt-5426", here.id)).toBeNull();
    expect(peerWorktree(s, "wt-ffff-1f", here.id)).toBeNull();
    expect(peerWorktree(s, "worker", here.id)).toBeNull();
    expect(peerWorktree(s, "a1cf47df67232752f", here.id)).toBeNull();
  });

  test("a directory read off the path, whatever the record's id", () => {
    const s = state([here, row("54dcccbdb0", "r1", "Old slot", { path: "/w/r1/wt-e96c" })]);
    expect(peerWorktree(s, "wt-e96c-0b", here.id)?.title).toBe("Old slot");
    expect(peerWorktree(s, "wt-54dc-0b", here.id)).toBeNull();
  });

  test("main and the spare stay as written", () => {
    const s = state([
      here,
      row("d5b9f57ad9", "r1", "main", { kind: "main", path: "/p/toyon" }),
      row("aaaa000000", "r1", "", { kind: "spare" }),
      { id: "found", repoId: "r1", path: "/elsewhere/wt-bbbb" } as unknown as WorktreeStatus,
    ]);
    expect(peerWorktree(s, "toyon-1f", here.id)).toBeNull();
    expect(peerWorktree(s, "wt-aaaa-1f", here.id)).toBeNull();
    expect(peerWorktree(s, "wt-bbbb-1f", here.id)).toBeNull();
  });

  test("an archived worktree is found where the archive holds its record, a row before it", () => {
    const old = gone("5426ee22ff", "r1", "Featured media, older");
    expect(peerWorktree(state([here], { r1: [old] }), "wt-5426-1f", here.id)).toEqual({
      id: "5426ee22ff",
      title: "Featured media, older",
    });
    expect(peerWorktree(state([here, there], { r1: [old] }), "wt-5426-1f", here.id)?.id).toBe("5426aa11bb");
    expect(peerWorktree(state([here]), "wt-5426-1f", here.id)).toBeNull();
  });

  test("a directory two projects share is this project's, and nobody's from a third", () => {
    const twin = row("5426ff0000", "r2", "Twin");
    const s = state([here, there, twin]);
    expect(peerWorktree(s, "wt-5426-1f", here.id)?.id).toBe("5426aa11bb");
    expect(peerWorktree(s, "wt-5426-1f", twin.id)?.id).toBe("5426ff0000");
    expect(peerWorktree(s, "wt-5426-1f", row("9999000000", "r3", "Third").id)).toBeNull();
    expect(peerWorktree(state([there, twin]), "wt-5426-1f", null)).toBeNull();
  });

  test("the sender's project is read off an archived chat too", () => {
    const from = gone("061e0f34bb", "r1", "Send message flash");
    const s = state([there, row("5426ff0000", "r2", "Twin")], { r1: [from] });
    expect(peerWorktree(s, "wt-5426-1f", from.id)).toEqual({ id: "5426aa11bb", title: "Featured media" });
  });

  test("the key settles across fresh rows that say the same, and moves with a rename", () => {
    const a = peerKey(state([here, there]), "wt-5426-1f", here.id);
    expect(peerKey(state([here, { ...there }]), "wt-5426-1f", here.id)).toBe(a);
    expect(peerKey(state([here, row("5426aa11bb", "r1", "Media")]), "wt-5426-1f", here.id)).not.toBe(a);
    expect(peerKey(state([here]), "wt-5426-1f", here.id)).toBe("");
  });
});
