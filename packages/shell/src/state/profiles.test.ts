import { describe, expect, test } from "bun:test";
import type { RepoInfo } from "@toyon/shared";
import { profileNames, profileOf } from "./profiles.ts";

const plain: RepoInfo = {
  id: "r",
  path: "/r",
  name: "r",
  defaultBranch: "main",
  config: { run: {} },
  configFile: ".toyon/settings.json",
  needsSetup: false,
};
const profiled: RepoInfo = {
  ...plain,
  config: { run: { web: "w" }, profiles: { fe: { run: ["web"] }, full: { run: ["web"] } }, defaultProfile: "fe" },
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
});
