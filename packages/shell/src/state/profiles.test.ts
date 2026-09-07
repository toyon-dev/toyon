import { describe, expect, test } from "bun:test";
import type { RepoInfo } from "@toyon/shared";
import { nextProfile, profileNames, profileOf } from "./profiles.ts";

const plain: RepoInfo = {
  id: "r",
  path: "/r",
  name: "r",
  defaultBranch: "main",
  config: { procs: {} },
  needsSetup: false,
};
const profiled: RepoInfo = {
  ...plain,
  config: { procs: { web: "w" }, profiles: { fe: { procs: ["web"] }, full: { procs: ["web"] } }, defaultProfile: "fe" },
};

describe("profiles", () => {
  test("a repo without profiles has none, and its worktrees have no effective profile", () => {
    expect(profileNames(plain)).toEqual([]);
    expect(profileNames(null)).toEqual([]);
    expect(profileOf({ profile: "full" }, plain)).toBeUndefined();
  });

  test("effective profile: the worktree's own when it still exists, else the default", () => {
    expect(profileNames(profiled)).toEqual(["fe", "full"]);
    expect(profileOf({}, profiled)).toBe("fe");
    expect(profileOf({ profile: "full" }, profiled)).toBe("full");
    expect(profileOf({ profile: "gone" }, profiled)).toBe("fe");
  });

  test("nextProfile cycles in file order and starts from the first for an unknown current", () => {
    expect(nextProfile(["fe", "full"], "fe")).toBe("full");
    expect(nextProfile(["fe", "full"], "full")).toBe("fe");
    expect(nextProfile(["fe", "full"], undefined)).toBe("fe");
    expect(nextProfile([], "fe")).toBeUndefined();
  });
});
