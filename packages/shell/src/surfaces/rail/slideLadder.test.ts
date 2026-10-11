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
  test("archive, land, then the whole menu, in that order whatever the menu's is", () => {
    const ladder = slideLadder(grouped([[item("changes")], [item("land")], [item("archive", "archive…")]]));
    expect(ladder.map((r) => r.id)).toEqual(["archive", "land", "more"]);
    expect(ladder[0]?.label).toBe("archive…");
    expect(ladder[1]?.item?.id).toBe("land");
  });
  test("a verb the row is not offered keeps its rung, with nothing behind it", () => {
    const ladder = slideLadder(grouped([[item("changes")], [item("archive")]]));
    expect(ladder[1]).toMatchObject({ id: "land", label: "land", item: null });
  });
  test("more has no item: it is the menu itself", () => {
    expect(slideLadder([])[2]).toMatchObject({ id: "more", item: null });
  });
});
