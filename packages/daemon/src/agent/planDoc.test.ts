import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { isPlanPath, ownPlanPath, PLANS_DIR, planEdited, writePlanDoc } from "./planDoc.ts";

describe("plan documents", () => {
  let repo: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ repo, cleanup } = tmpRepo());
  });
  afterEach(() => cleanup());

  test("each plan is the next numbered file, and a number is never given twice", async () => {
    expect(await writePlanDoc(repo, "# one")).toBe(`${PLANS_DIR}/1.md`);
    expect(await writePlanDoc(repo, "# two\n")).toBe(`${PLANS_DIR}/2.md`);
    expect(readFileSync(join(repo, PLANS_DIR, "1.md"), "utf8")).toBe("# one\n");
    expect(readFileSync(join(repo, PLANS_DIR, "2.md"), "utf8")).toBe("# two\n");
    expect(await writePlanDoc(repo, "# three")).toBe(`${PLANS_DIR}/3.md`);
    // a plan deleted by hand leaves a gap, and a card still holding that number must not find a
    // different plan under it
    unlinkSync(join(repo, PLANS_DIR, "2.md"));
    expect(await writePlanDoc(repo, "# four")).toBe(`${PLANS_DIR}/4.md`);
  });

  test("a plan re-sent unchanged names the file already there", async () => {
    expect(await writePlanDoc(repo, "# one")).toBe(`${PLANS_DIR}/1.md`);
    // an agent answering a question in plan mode submits the same plan again
    expect(await writePlanDoc(repo, "# one")).toBe(`${PLANS_DIR}/1.md`);
    expect(await writePlanDoc(repo, "# one\n")).toBe(`${PLANS_DIR}/1.md`);
    expect(existsSync(join(repo, PLANS_DIR, "2.md"))).toBe(false);
    // only the newest counts: a revision that goes back to an older wording is still a new round
    expect(await writePlanDoc(repo, "# two")).toBe(`${PLANS_DIR}/2.md`);
    expect(await writePlanDoc(repo, "# one")).toBe(`${PLANS_DIR}/3.md`);
    // a file the person edited in the pane no longer says what the agent proposed
    writeFileSync(join(repo, PLANS_DIR, "3.md"), "# one, edited\n");
    expect(await writePlanDoc(repo, "# one")).toBe(`${PLANS_DIR}/4.md`);
    expect(readFileSync(join(repo, PLANS_DIR, "3.md"), "utf8")).toBe("# one, edited\n");
  });

  test("the folder is kept out of git once, as a whole", async () => {
    await writePlanDoc(repo, "# one");
    await writePlanDoc(repo, "# two");
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === `${PLANS_DIR}/`)).toHaveLength(1);
    expect(sh(repo, "git", "status", "--porcelain")).toBe("");
  });

  test("an edit is judged against the file the card named", async () => {
    const one = (await writePlanDoc(repo, "# one"))!;
    const two = (await writePlanDoc(repo, "# two"))!;
    writeFileSync(join(repo, two), "# two, revised\n");
    expect(planEdited(repo, one, "# one")).toBe(false);
    expect(planEdited(repo, two, "# two")).toBe(true);
    // a file that went is not an edit
    expect(planEdited(repo, `${PLANS_DIR}/9.md`, "# nine")).toBe(false);
  });

  test("only a plan's own path is one", () => {
    expect(isPlanPath(`${PLANS_DIR}/1.md`)).toBe(true);
    expect(isPlanPath(`${PLANS_DIR}/12.md`)).toBe(true);
    // the names Claude makes up for its own file
    expect(isPlanPath(`${PLANS_DIR}/plan-how-to-rename-indexed-gray.md`)).toBe(true);
    expect(isPlanPath(`${PLANS_DIR}/../record.json`)).toBe(false);
    expect(isPlanPath(`${PLANS_DIR}/..md`)).toBe(false);
    expect(isPlanPath(`${PLANS_DIR}/.hidden.md`)).toBe(false);
    expect(isPlanPath(`${PLANS_DIR}/1.md/x`)).toBe(false);
    expect(isPlanPath(`${PLANS_DIR}/a/b.md`)).toBe(false);
    expect(isPlanPath(".toyon/plan.md")).toBe(false);
    expect(isPlanPath("1.md")).toBe(false);
  });

  test("the agent's own plan file is named relative to the worktree, and only from its plans folder", () => {
    expect(ownPlanPath(repo, join(repo, PLANS_DIR, "bagels-quiet-owl.md"))).toBe(`${PLANS_DIR}/bagels-quiet-owl.md`);
    // reported as the OS resolved it, which on macOS is not the path the worktree was opened by
    expect(ownPlanPath(repo, join(realpathSync(repo), PLANS_DIR, "bagels-quiet-owl.md"))).toBe(
      `${PLANS_DIR}/bagels-quiet-owl.md`,
    );
    // an agent whose settings keep its plans under its home: the card gets a copy instead
    expect(ownPlanPath(repo, join(homedir(), ".claude", "plans", "bagels-quiet-owl.md"))).toBeNull();
    expect(ownPlanPath(repo, join(repo, ".toyon", "plan.md"))).toBeNull();
    expect(ownPlanPath(repo, join(repo, PLANS_DIR, "deeper", "x.md"))).toBeNull();
    expect(ownPlanPath(repo, join(repo, PLANS_DIR, "notes.txt"))).toBeNull();
    expect(ownPlanPath(repo, join(repo, PLANS_DIR, "..", "settings.json"))).toBeNull();
  });

  test("a worktree that will not take the file leaves the plan on the card", async () => {
    writeFileSync(join(repo, ".toyon"), "a file where the folder should be\n");
    expect(await writePlanDoc(repo, "# one")).toBeNull();
    expect(existsSync(join(repo, PLANS_DIR))).toBe(false);
  });
});
