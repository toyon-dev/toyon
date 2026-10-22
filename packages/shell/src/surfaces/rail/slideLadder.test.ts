import { describe, expect, test } from "bun:test";
import { grouped, type MenuItem } from "../../ui/menu.ts";
import { slideLadder } from "./slideLadder.ts";

const item = (id: string, label = id, extra: Partial<MenuItem> = {}): MenuItem => ({
  id,
  label,
  onClick: () => {},
  ...extra,
});

describe("the ladder a row slides through", () => {
  test("land, archive, then the whole menu, in that order whatever the menu's is", () => {
    const ladder = slideLadder(grouped([[item("changes")], [item("archive", "archive…")], [item("land")]]));
    expect(ladder.map((r) => r.id)).toEqual(["land", "archive", "more"]);
    expect(ladder[0]?.item?.id).toBe("land");
    expect(ladder[1]?.label).toBe("archive…");
  });
  test("a landed row has no land rung, so archive is its short drag", () => {
    const ladder = slideLadder(grouped([[item("changes")], [item("archive")]]));
    expect(ladder.map((r) => r.id)).toEqual(["archive", "more"]);
  });
  test("a busy row keeps its land rung, off, rather than dropping it", () => {
    const ladder = slideLadder(grouped([[item("land", "land", { disabled: "waiting on the one in progress" })]]));
    expect(ladder[0]).toMatchObject({ id: "land", item: { disabled: "waiting on the one in progress" } });
  });
  test("more is always last and has no item: it is the menu itself", () => {
    expect(slideLadder([])).toEqual([{ id: "more", label: "more", icon: "more", item: null }]);
  });
});
