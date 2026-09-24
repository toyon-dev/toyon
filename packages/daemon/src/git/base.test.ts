import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { resolveBase } from "./base.ts";
import { GIT } from "./exec.ts";

describe("resolveBase", () => {
  let t: ReturnType<typeof tmpRepo>;
  beforeEach(() => {
    t = tmpRepo();
  });
  afterEach(() => t.cleanup());

  const withOrigin = () => {
    const origin = join(dirname(t.repo), "origin.git");
    sh(t.repo, GIT, "init", "-q", "--bare", "-b", "main", origin);
    sh(t.repo, GIT, "remote", "add", "origin", origin);
    sh(t.repo, GIT, "push", "-q", "-u", "origin", "main");
  };

  test("the merge route is main here, upstream or not", async () => {
    withOrigin();
    expect(await resolveBase(t.repo, "main", "merge")).toBe("main");
  });

  test("the push and pr routes are main's upstream once it has one", async () => {
    expect(await resolveBase(t.repo, "main", "push")).toBe("main");
    expect(await resolveBase(t.repo, "main", "pr")).toBe("main");
    withOrigin();
    expect(await resolveBase(t.repo, "main", "push")).toBe("origin/main");
    expect(await resolveBase(t.repo, "main", "pr")).toBe("origin/main");
  });

  test("an upstream git cannot resolve is not a base: the count against it would read as level", async () => {
    // tracking configured by hand before any fetch: no remote-tracking ref exists yet
    sh(t.repo, GIT, "remote", "add", "origin", join(dirname(t.repo), "nowhere.git"));
    sh(t.repo, GIT, "config", "branch.main.remote", "origin");
    sh(t.repo, GIT, "config", "branch.main.merge", "refs/heads/main");
    expect(await resolveBase(t.repo, "main", "push")).toBe("main");
  });
});
