import { isItem, type MenuEntry, type MenuItem } from "../../ui/menu.ts";

/** One rung of a row's slide: the word the row uncovers, and the menu item it does. `item` is null
 * on a row the verb is not offered on, so the rung still reads and teaches but does nothing; `more`
 * has no item of its own, being the whole menu. */
export type Rung = {
  id: "archive" | "land" | "more";
  label: string;
  item: MenuItem | null;
  danger?: boolean;
};

/** The ladder every row slides through, in one fixed order so the hand learns it: archive first,
 * the one that is undone from the archived section, then land, then the whole menu. Read off the
 * row's own menu, so the slide offers exactly what the menu does and nothing twice. */
export function slideLadder(items: MenuEntry[]): Rung[] {
  const find = (id: string) => items.filter(isItem).find((i) => i.id === id) ?? null;
  const archive = find("archive");
  const land = find("land");
  return [
    { id: "archive", label: archive?.label ?? "archive", item: archive, danger: true },
    { id: "land", label: land?.label ?? "land", item: land },
    { id: "more", label: "more", item: null },
  ];
}
