import { describe, expect, test } from "bun:test";
import type { OwnedWorktree } from "@toyon/shared";
import { insertedWorktree, matchesSibling, pastedWorktree, siblingWorktrees } from "./siblings.ts";

const row = (
  id: string,
  repoId: string,
  kind: "main" | "worktree" | "spare",
  title = id,
  extra: Partial<OwnedWorktree> = {},
): OwnedWorktree =>
  ({
    id,
    repoId,
    path: `/p/wt-${id}`,
    name: title,
    procs: [],
    agent: "idle",
    login: false,
    worktree: { id, repoId, path: `/p/wt-${id}`, branch: `toyon/${id}`, kind, title, createdAt: 5 },
    ...extra,
  }) as unknown as OwnedWorktree;

describe("siblingWorktrees", () => {
  const rows = [
    row("main", "r1", "main"),
    row("a", "r1", "worktree", "Row a", { agent: "working" }),
    row("spare", "r1", "spare"),
    row("b", "r1", "worktree", "Row b"),
    row("c", "r2", "worktree"),
  ];

  test("the project's worktree rows in the order given, less the one the message is in, with the rail's dot and time", () => {
    expect(siblingWorktrees(rows, "r1", "a")).toEqual([
      { id: "b", title: "Row b", branch: "toyon/b", dir: "wt-b", dot: "idle", state: "Idle", at: 5 },
    ]);
    expect(siblingWorktrees(rows, "r1", null).map((w) => [w.id, w.dot])).toEqual([
      ["a", "working"],
      ["b", "idle"],
    ]);
  });

  test("main, the spare and another project's rows are not chats to point at", () => {
    expect(siblingWorktrees(rows, "r2", "c")).toEqual([]);
    expect(siblingWorktrees(rows, undefined, "a")).toEqual([]);
  });
});

describe("matchesSibling", () => {
  const w = { id: "108c905080", title: "Message flash bug", branch: "toyon/message-flash-bug", dir: "wt-108c" };

  test("the title typed as its slug, run together, with its spaces, or in part", () => {
    expect(matchesSibling("message-flash", w)).toBe(true);
    expect(matchesSibling("messageflash", w)).toBe(true);
    expect(matchesSibling("message flash", w)).toBe(true);
    expect(matchesSibling("Flash", w)).toBe(true);
    expect(matchesSibling("flashbug", w)).toBe(true);
  });

  test("the branch, the id a transcript is named by, and the directory", () => {
    expect(matchesSibling("toyon/mess", w)).toBe(true);
    expect(matchesSibling("108c90", w)).toBe(true);
    expect(matchesSibling("wt-108c", w)).toBe(true);
  });

  test("nothing typed matches everything; the wrong letters match nothing", () => {
    expect(matchesSibling("", w)).toBe(true);
    expect(matchesSibling("readme", w)).toBe(false);
  });

  test("punctuation alone names nothing: it is not the bare `@`", () => {
    expect(matchesSibling("-", w)).toBe(false);
    expect(matchesSibling("`", w)).toBe(false);
    expect(matchesSibling("...", w)).toBe(false);
    expect(matchesSibling("- ", w)).toBe(false);
  });

  test("the id and the directory are read from their start, and not by a lone hex character", () => {
    // a digit or an a-f letter is in nearly every id: it names the title or branch alone
    expect(matchesSibling("3", w)).toBe(false);
    expect(matchesSibling("0", w)).toBe(false);
    expect(matchesSibling("c9", w)).toBe(false);
    expect(matchesSibling("10", w)).toBe(false);
    // three characters of the start name it; the same three from the middle do not
    expect(matchesSibling("108", w)).toBe(true);
    expect(matchesSibling("wt-1", w)).toBe(true);
    expect(matchesSibling("905", w)).toBe(false);
    // a letter still finds the title anywhere in it
    expect(matchesSibling("g", w)).toBe(true);
  });

  test("a trailing space holds only while a name has more to come", () => {
    // the title's next word is about to be typed
    expect(matchesSibling("message ", w)).toBe(true);
    expect(matchesSibling("message flash ", w)).toBe(true);
    // the name is typed whole: the space after it is the sentence going on
    expect(matchesSibling("toyon/message-flash-bug ", w)).toBe(false);
    expect(matchesSibling("message flash bug ", w)).toBe(false);
    expect(matchesSibling("wt-108c ", w)).toBe(false);
    // without the space the whole name still names it, so the row is offered to pick
    expect(matchesSibling("toyon/message-flash-bug", w)).toBe(true);
  });
});

describe("pastedWorktree", () => {
  const names = [
    { branch: "toyon/code-review", dir: "wt-d55a" },
    { branch: "toyon/flash-bug", dir: "wt-108c" },
  ];

  test("a branch or a directory pasted whole becomes the reference, with the space that lets the sentence go on", () => {
    expect(pastedWorktree("toyon/code-review", names)).toBe("@toyon/code-review ");
    expect(pastedWorktree("wt-108c", names)).toBe("@toyon/flash-bug ");
    // a terminal's copy brings its line end along
    expect(pastedWorktree("toyon/code-review\n", names)).toBe("@toyon/code-review ");
  });

  test("the first of two records with the name wins: the row open now over the archive's", () => {
    const twice = [...names, { branch: "toyon/code-review", dir: "wt-0000" }];
    expect(pastedWorktree("wt-0000", twice)).toBe("@toyon/code-review ");
    expect(pastedWorktree("toyon/code-review", [{ branch: "toyon/code-review", dir: "wt-9999" }, ...names])).toBe(
      "@toyon/code-review ",
    );
  });

  test("anything else pastes as it is: a name among words, a reference already written, a stranger, nothing", () => {
    expect(pastedWorktree("see toyon/code-review", names)).toBeNull();
    expect(pastedWorktree("@toyon/code-review", names)).toBeNull();
    expect(pastedWorktree("toyon/code-revie", names)).toBeNull();
    expect(pastedWorktree("Toyon/Code-Review", names)).toBeNull();
    expect(pastedWorktree("wt-d55a/packages", names)).toBeNull();
    expect(pastedWorktree("  ", names)).toBeNull();
    expect(pastedWorktree("toyon/code-review", [])).toBeNull();
  });
});

describe("insertedWorktree", () => {
  const names = [
    { branch: "toyon/code-review", dir: "wt-d55a" },
    { branch: "fixes", dir: "wt-108c" },
  ];

  test("a keyboard's clipboard key putting a branch or directory in whole reads as the paste would", () => {
    expect(insertedWorktree("toyon/code-review", names)).toBe("@toyon/code-review ");
    expect(insertedWorktree("wt-108c", names)).toBe("@fixes ");
  });

  test("a name a keyboard could offer as a word suggestion does not: typing never tags", () => {
    expect(insertedWorktree("fixes", names)).toBeNull();
    // a typed character, or a name among words, as with a paste
    expect(insertedWorktree("t", names)).toBeNull();
    expect(insertedWorktree("see toyon/code-review", names)).toBeNull();
  });
});
