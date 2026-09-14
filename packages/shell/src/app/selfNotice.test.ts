import { describe, expect, test } from "bun:test";
import type { RepoInfo, SelfState } from "@toyon/shared";
import { selfNotice } from "./selfNotice.ts";

const repos = [{ id: "r1", defaultBranch: "trunk" } as RepoInfo];
const state = (over: Partial<SelfState> = {}): SelfState => ({
  repoId: "r1",
  rebuild: false,
  restart: false,
  building: false,
  ...over,
});

describe("selfNotice", () => {
  test("nothing to say on every install that is not toyon's own", () => {
    expect(selfNotice(null, repos)).toBeNull();
  });

  test("a stale bundle offers the rebuild and not the restart", () => {
    const n = selfNotice(state({ rebuild: true, restart: true }), repos);
    expect(n).toMatchObject({ build: "rebuild", busy: false });
    // restarting first would come back up serving the same stale bundle
    expect(n?.restart).toBeUndefined();
  });

  test("once the bundles are level the restart is what is left", () => {
    const n = selfNotice(state({ restart: true }), repos);
    expect(n).toMatchObject({ restart: true });
    expect(n?.build).toBeUndefined();
  });

  test("a running build offers neither and says so", () => {
    const n = selfNotice(state({ rebuild: true, building: true }), repos);
    expect(n).toMatchObject({ busy: true });
    expect(n?.build).toBeUndefined();
    expect(n?.restart).toBeUndefined();
    expect(n?.text).toBe("Rebuilding Toyon from trunk");
  });

  test("a failed build carries what it printed, and offers another go", () => {
    const n = selfNotice(state({ rebuild: true, buildFailed: "error TS2322" }), repos);
    expect(n).toMatchObject({ build: "try again", detail: "error TS2322", busy: false });
  });

  test("the project's own branch name is what the text uses", () => {
    expect(selfNotice(state({ rebuild: true }), repos)?.text).toBe("Toyon's shell is behind trunk");
    // a project the shell has not been told about yet still reads as a sentence
    expect(selfNotice(state({ rebuild: true }), [])?.text).toBe("Toyon's shell is behind the default branch");
  });
});
