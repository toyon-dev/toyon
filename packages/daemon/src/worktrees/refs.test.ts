import { describe, expect, test } from "bun:test";
import type { GitRef } from "../git/refs.ts";
import { type PrHit, parsePrList, rankRefs } from "./refs.ts";

const ref = (name: string, over: Partial<GitRef> = {}): GitRef => ({ name, sha: "abc", at: 1, subject: "", ...over });
const pr = (number: number, over: Partial<PrHit> = {}): PrHit => ({
  number,
  title: `pr ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  author: "kyle",
  draft: false,
  head: `feature-${number}`,
  fork: false,
  updatedAt: 5,
  ...over,
});
const rowIdForPath = (p: string) => (p === "/w/checked" ? "row-checked" : null);
const rank = (over: Partial<Parameters<typeof rankRefs>[0]>) =>
  rankRefs({ refs: [], merged: new Set(), prs: [], query: "", defaultBranch: "main", rowIdForPath, ...over });

describe("rankRefs", () => {
  test("the default listing is unmerged local branches nobody has out, plus open PRs", () => {
    const refs = [
      ref("main", { worktreePath: "/w/main" }),
      ref("open-work", { at: 3 }),
      ref("landed", { at: 9 }),
      ref("checked", { worktreePath: "/w/checked" }),
      ref("remote-only", { remote: "origin" }),
    ];
    const hits = rank({ refs, merged: new Set(["landed"]), prs: [pr(7)] });
    expect(hits.map((h) => `${h.kind}:${h.ref}`)).toEqual(["pr:7", "branch:open-work"]);
    expect(hits[0]?.name).toBe("#7 pr 7");
    expect(hits[0]?.pr?.author).toBe("kyle");
  });

  test("a query finds merged and checked-out branches, marks them, and reaches remotes", () => {
    const refs = [
      ref("landed-thing", { at: 9 }),
      ref("checked", { worktreePath: "/w/checked" }),
      ref("checked", { remote: "origin" }),
      ref("only-on-origin", { remote: "origin", subject: "checked in from afar" }),
    ];
    const hits = rank({ refs, merged: new Set(["landed-thing"]), query: "check" });
    expect(hits.map((h) => `${h.kind}:${h.name}`)).toEqual(["branch:checked", "remote:origin/only-on-origin"]);
    expect(hits[0]?.openIn).toBe("row-checked");
    expect(rank({ refs, merged: new Set(["landed-thing"]), query: "landed" })[0]).toMatchObject({
      kind: "branch",
      merged: true,
    });
  });

  test("a local branch shadows its remote of the same name", () => {
    const refs = [ref("x"), ref("x", { remote: "origin" })];
    expect(rank({ refs, query: "x" }).map((h) => h.kind)).toEqual(["branch"]);
  });

  test("a PR is found by number or title, and resolves to the row that has its head out", () => {
    const refs = [ref("feature-42", { worktreePath: "/w/checked" }), ref("pr/9", { worktreePath: "/w/checked" })];
    const prs = [pr(42, { title: "shiny buttons" }), pr(9), pr(3, { fork: true, draft: true })];
    expect(rank({ refs, prs, query: "#42" }).map((h) => h.ref)).toEqual(["42"]);
    expect(rank({ refs, prs, query: "shiny" })[0]?.openIn).toBe("row-checked");
    expect(rank({ refs, prs, query: "pr 9" })[0]?.openIn).toBe("row-checked");
    expect(rank({ refs, prs, query: "pr 3" })[0]?.pr).toMatchObject({ fork: true, draft: true });
  });

  test("an exact prefix on the name outranks a later match, then newest first", () => {
    const refs = [ref("zz-fix-login", { at: 9 }), ref("login", { at: 1 }), ref("login-2", { at: 5 })];
    expect(rank({ refs, query: "login" }).map((h) => h.name)).toEqual(["login-2", "login", "zz-fix-login"]);
  });
});

describe("parsePrList", () => {
  test("keeps what the palette needs and drops rows missing a number or a head", () => {
    const json = JSON.stringify([
      {
        number: 4,
        title: "t",
        url: "u",
        author: { login: "me" },
        headRefName: "h",
        isDraft: true,
        isCrossRepository: false,
        updatedAt: "2026-09-10T00:00:00Z",
      },
      { title: "no number", headRefName: "h" },
      { number: 5 },
    ]);
    expect(parsePrList(json)).toEqual([
      {
        number: 4,
        title: "t",
        url: "u",
        author: "me",
        draft: true,
        head: "h",
        fork: false,
        updatedAt: Date.parse("2026-09-10T00:00:00Z"),
      },
    ]);
    expect(parsePrList("not json")).toEqual([]);
    expect(parsePrList("{}")).toEqual([]);
  });
});
