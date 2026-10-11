import type { IconName } from "../../ui/Icon.tsx";
import { isItem, type MenuEntry, type MenuItem } from "../../ui/menu.ts";

/** One rung of a row's slide: the word and the glyph the row uncovers, and the menu item it does.
 * `item` is null on a row the verb is not offered on, so the rung still reads and teaches but does
 * nothing; `more` has no item of its own, being the whole menu. */
export type Rung = {
  /** named on the cell while the rung is live, which is what the rail's stylesheet colours by */
  id: "archive" | "land" | "more";
  label: string;
  icon: IconName;
  item: MenuItem | null;
};

/** The ladder every row slides through, in one fixed order so the hand learns it: archive first,
 * the one that is undone from the archived section, then land, then the whole menu. Read off the
 * row's own menu, so the slide offers exactly what the menu does and nothing twice. */
export function slideLadder(items: MenuEntry[]): Rung[] {
  const find = (id: string) => items.filter(isItem).find((i) => i.id === id) ?? null;
  const archive = find("archive");
  const land = find("land");
  return [
    { id: "archive", label: archive?.label ?? "archive", icon: "archive", item: archive },
    { id: "land", label: land?.label ?? "land", icon: "land", item: land },
    { id: "more", label: "more", icon: "more", item: null },
  ];
}
