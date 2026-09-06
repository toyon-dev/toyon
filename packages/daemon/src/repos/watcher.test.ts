import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT } from "../git/exec.ts";
import { watchDefaultBranch } from "./watcher.ts";

// The watcher turns noisy .git fs events into one "main moved" per ref change, confirmed by
// rev-parse, and stays silent for churn that leaves the ref where it was.

let t: ReturnType<typeof tmpRepo>;
beforeAll(() => {
  t = tmpRepo();
});
afterAll(() => t.cleanup());

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("a commit on main fires once; index churn without a ref move does not", async () => {
  let moves = 0;
  const stop = watchDefaultBranch(t.repo, "main", () => moves++);
  await settle(300); // baseline rev-parse
  writeFileSync(join(t.repo, "a.txt"), "a\n");
  sh(t.repo, GIT, "add", "-A"); // touches .git/index only
  await settle(1500);
  expect(moves).toBe(0);
  sh(t.repo, GIT, "commit", "-q", "-m", "a");
  await settle(2500);
  expect(moves).toBe(1);
  stop();
  sh(t.repo, GIT, "commit", "-q", "--allow-empty", "-m", "after stop");
  await settle(1500);
  expect(moves).toBe(1);
}, 15000);
