import type { IconName } from "../../ui/Icon.tsx";
import { isItem, type MenuEntry, type MenuItem } from "../../ui/menu.ts";

/** One rung of a row's slide: the word and the glyph the row uncovers, and the menu item it does.
 * `more` has no item of its own, being the whole menu. */
export type Rung = {
  /** named on the cell while the rung is live, which is what the rail's stylesheet colours by */
  id: "archive" | "land" | "more";
  label: string;
  icon: IconName;
  item: MenuItem | null;
};

/** The ladder a row slides through: land, then archive, then the whole menu, in one fixed
 * precedence so the hand learns it, and only the rungs the row offers. The short drag is the
 * row's next step: land while there is work to land, and archive once it has landed, where the
 * land rung drops out and archive moves up to take its place. Read off the row's own menu, so the
 * slide offers exactly what the menu does and nothing twice. */
export function slideLadder(items: MenuEntry[]): Rung[] {
  const find = (id: string) => items.filter(isItem).find((i) => i.id === id) ?? null;
  const land = find("land");
  const archive = find("archive");
  return [
    ...(land ? [{ id: "land" as const, label: land.label, icon: "land" as const, item: land }] : []),
    ...(archive ? [{ id: "archive" as const, label: archive.label, icon: "archive" as const, item: archive }] : []),
    { id: "more", label: "more", icon: "more", item: null },
  ];
}
