import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { isPlanPath, PLANS_DIR, planEdited, writePlanDoc } from "./planDoc.ts";

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
    expect(isPlanPath(`${PLANS_DIR}/../record.json`)).toBe(false);
    expect(isPlanPath(`${PLANS_DIR}/plan.md`)).toBe(false);
    expect(isPlanPath(`${PLANS_DIR}/1.md/x`)).toBe(false);
    expect(isPlanPath(".toyon/plan.md")).toBe(false);
    expect(isPlanPath("1.md")).toBe(false);
  });

  test("a worktree that will not take the file leaves the plan on the card", async () => {
    writeFileSync(join(repo, ".toyon"), "a file where the folder should be\n");
    expect(await writePlanDoc(repo, "# one")).toBeNull();
    expect(existsSync(join(repo, PLANS_DIR))).toBe(false);
  });
});
