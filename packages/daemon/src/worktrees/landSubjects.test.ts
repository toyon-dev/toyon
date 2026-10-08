import { describe, expect, test } from "bun:test";
import type { LandMark } from "@toyon/shared";
import { fillLandMarks, unfilled } from "./landSubjects.ts";

describe("fillLandMarks", () => {
  /** a mark as an older daemon wrote it: no subjects at all */
  const stored = (tip: string) => ({ base: "b", tip, at: 1 }) as LandMark;

  test("tells a loaded mark without subjects from one with them", () => {
    expect(unfilled(stored("t"))).toBe(true);
    expect(unfilled({ base: "b", tip: "t", at: 1, subjects: [] })).toBe(false);
  });

  test("fills every mark in place from its own checkout, a few at a time, in the order given", async () => {
    const asked: string[] = [];
    let open = 0;
    let most = 0;
    const jobs = ["a", "b", "c", "d", "e"].map((tip) => ({ mark: stored(tip), cwd: `/repo-${tip}` }));
    await fillLandMarks(
      jobs,
      async (cwd, m) => {
        asked.push(`${cwd}:${m.tip}`);
        open++;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 5));
        open--;
        return [`add ${m.tip}`];
      },
      2,
    );
    expect(asked).toEqual(["/repo-a:a", "/repo-b:b", "/repo-c:c", "/repo-d:d", "/repo-e:e"]);
    expect(most).toBe(2);
    expect(jobs.map((j) => j.mark.subjects)).toEqual([["add a"], ["add b"], ["add c"], ["add d"], ["add e"]]);
    expect(jobs.every((j) => !unfilled(j.mark))).toBe(true);
  });

  test("a range git cannot read is written as nothing to say, so it is not asked again", async () => {
    const jobs = [{ mark: stored("gone"), cwd: "/repo" }];
    await fillLandMarks(jobs, async () => null);
    expect(jobs[0]?.mark).toEqual({ base: "b", tip: "gone", at: 1, subjects: [] });
    await fillLandMarks([], async () => ["never"]);
  });
});
