import { describe, expect, test } from "bun:test";
import type { ArchivedWorktree, OwnedWorktree } from "@toyon/shared";
import { Marked } from "marked";
import { namerFrom, namesKey, type WorktreeNamer, worktreeMention, worktreeNames } from "./markdownWorktree.ts";

const row = (id: string, repoId: string, title: string, kind: "main" | "worktree" = "worktree"): OwnedWorktree =>
  ({
    id,
    repoId,
    path: `/p/wt-${id.slice(0, 4)}`,
    worktree: {
      id,
      repoId,
      path: `/p/wt-${id.slice(0, 4)}`,
      branch: `toyon/${title.toLowerCase().replace(/ /g, "-")}`,
      kind,
      title,
      createdAt: 5,
    },
  }) as unknown as OwnedWorktree;

const gone = (id: string, repoId: string, title: string): ArchivedWorktree =>
  ({
    id,
    repoId,
    title,
    branch: `toyon/${title.toLowerCase().replace(/ /g, "-")}`,
    path: `/p/wt-${id.slice(0, 4)}`,
    createdAt: 1,
    archivedAt: 2,
    restorable: true,
  }) as ArchivedWorktree;

const rows = [
  row("d486aa11bb", "r1", "Table edge fade"),
  row("deab00cc11", "r1", "Worktree naming"),
  row("f35f", "r2", "Other project"),
];
const archived = [gone("16b6ee22ff", "r1", "Smooth streaming"), gone("d486aa11bb", "r1", "Table edge fade, older")];

describe("worktreeNames", () => {
  test("lists the project's rows by directory, then its archive, a live row winning its directory", () => {
    expect(worktreeNames(rows, archived, "r1")).toEqual([
      { dir: "wt-d486", id: "d486aa11bb", title: "Table edge fade", branch: "toyon/table-edge-fade" },
      { dir: "wt-deab", id: "deab00cc11", title: "Worktree naming", branch: "toyon/worktree-naming" },
      { dir: "wt-16b6", id: "16b6ee22ff", title: "Smooth streaming", branch: "toyon/smooth-streaming", archived: true },
    ]);
  });
  test("the key settles across fresh row arrays that say the same names, and moves with a rename", () => {
    const s = { visible: rows, archived: { r1: archived } };
    const a = namesKey(s, "r1");
    expect(namesKey({ ...s, visible: [...rows] }, "r1")).toBe(a);
    const renamed = [...rows];
    renamed[0] = row("d486aa11bb", "r1", "Table fade");
    expect(namesKey({ ...s, visible: renamed }, "r1")).not.toBe(a);
    expect(namerFrom(a)("wt-16b6")?.title).toBe("Smooth streaming");
    expect(namerFrom(a)("wt-ffff")).toBeNull();
  });
});

describe("a wt-xxxx in the agent's prose", () => {
  const namer: WorktreeNamer = (dir) =>
    dir === "wt-d486"
      ? { dir, id: "d486aa11bb", title: 'Table "edge" fade', branch: "toyon/table-edge-fade" }
      : dir === "wt-16b6"
        ? { dir, id: "16b6ee22ff", title: "Smooth streaming", branch: "toyon/smooth-streaming", archived: true }
        : null;
  const md = new Marked({ extensions: [worktreeMention(() => namer)] });
  const render = (s: string) => md.parseInline(s, { async: false }) as string;
  // the title sits in an attribute too, so its quotes are escaped there; the dot goes out empty
  // for the log to fill in from the rows (mentionDots.ts)
  const chip =
    '<span class="chat-mention" data-worktree="d486aa11bb" data-branch="toyon/table-edge-fade" data-dir="wt-d486" data-tip="Table &quot;edge&quot; fade" data-tip-detail="toyon/table-edge-fade\nwt-d486" data-tip-placement="follow">@<span class="chat-mention-dot"><span class="dot"></span></span>Table "edge" fade</span>';

  test("bare, reads as the row's title with its sigil, the branch in the tip", () => {
    expect(render("behind wt-d486's eval on the shared tier")).toBe(`behind ${chip}&#39;s eval on the shared tier`);
  });
  test("in a code span of its own, the same", () => {
    expect(render("behind `wt-d486` now")).toBe(`behind ${chip} now`);
  });
  test("an archived row says so, wears the hollow dot from the start, and its press opens its page", () => {
    expect(render("see wt-16b6.")).toBe(
      'see <span class="chat-mention" data-worktree="16b6ee22ff" data-branch="toyon/smooth-streaming" data-dir="wt-16b6" data-archived="" data-tip="Smooth streaming" data-tip-detail="archived\ntoyon/smooth-streaming\nwt-16b6" data-tip-dot="archived" data-tip-placement="follow">@<span class="chat-mention-dot"><span class="dot archived"></span></span>Smooth streaming</span>.',
    );
  });
  test("a directory no row has stays as written, backticks and all", () => {
    expect(render("in wt-ffff and `wt-ffff`")).toBe("in wt-ffff and <code>wt-ffff</code>");
  });
  test("a segment of a path stays the path", () => {
    expect(render("under /p/wt-d486/src and `/p/wt-d486/src`")).toBe(
      "under /p/wt-d486/src and <code>/p/wt-d486/src</code>",
    );
  });
  test("the tail of a longer word or a longer span is not a worktree", () => {
    expect(render("newt-d486 and `cd wt-d486` and wt-d486-old")).toBe(
      "newt-d486 and <code>cd wt-d486</code> and wt-d486-old",
    );
  });
  test("with no namer, nothing changes", () => {
    const bare = new Marked({ extensions: [worktreeMention(() => undefined)] });
    expect(bare.parseInline("see wt-d486", { async: false })).toBe("see wt-d486");
  });
});
