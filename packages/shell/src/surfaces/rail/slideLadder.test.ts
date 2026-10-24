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
  test("archive, then the whole menu, whatever the menu's order", () => {
    const ladder = slideLadder(grouped([[item("changes")], [item("land")], [item("archive", "archive…")]]));
    expect(ladder.map((r) => r.id)).toEqual(["archive", "more"]);
    expect(ladder[0]?.item?.id).toBe("archive");
    expect(ladder[0]?.label).toBe("archive…");
  });
  test("land is never a rung, even when the menu offers it", () => {
    const ladder = slideLadder(grouped([[item("land")]]));
    expect(ladder.map((r) => r.id)).toEqual(["more"]);
  });
  test("a busy row keeps its archive rung, off, rather than dropping it", () => {
    const ladder = slideLadder(grouped([[item("archive", "archive", { disabled: "waiting on the one in progress" })]]));
    expect(ladder[0]).toMatchObject({ id: "archive", item: { disabled: "waiting on the one in progress" } });
  });
  test("more is always last and has no item: it is the menu itself", () => {
    expect(slideLadder([])).toEqual([{ id: "more", label: "more", icon: "more", item: null }]);
  });
});
