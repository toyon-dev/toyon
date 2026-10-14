import { describe, expect, test } from "bun:test";
import { isItem, type MenuItem } from "../../ui/menu.ts";
import { versionItems } from "./version.ts";

const item = (entries: ReturnType<typeof versionItems>, id: string): MenuItem | undefined =>
  entries.filter(isItem).find((it) => it.id === id);

describe("versionItems", () => {
  test("the release notes open in the centre when there is a centre to open them in", () => {
    let opened = 0;
    const row = item(
      versionItems("0.14.0", null, () => opened++),
      "release-notes",
    );
    expect(row?.label).toBe("release notes");
    row?.onClick?.();
    expect(opened).toBe(1);
  });

  test("without a view to show, the row names the version and leads to its release", () => {
    const row = item(versionItems("0.14.0", null), "release-notes");
    expect(row?.label).toBe("release notes for 0.14.0");
  });

  test("the check stays on the list where a policy takes it away, and says who did", () => {
    expect(item(versionItems("0.14.0", null), "check-update")).toBeUndefined();
    const off = item(versionItems("0.14.0", { run: () => {}, off: "managed by your organization" }), "check-update");
    expect(off?.disabled).toBe("managed by your organization");
  });
});
