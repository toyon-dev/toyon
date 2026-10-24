import type { IconName } from "../../ui/Icon.tsx";
import { isItem, type MenuEntry, type MenuItem } from "../../ui/menu.ts";

/** One rung of a row's slide: the word and the glyph the row uncovers, and the menu item it does.
 * `more` has no item of its own, being the whole menu. */
export type Rung = {
  /** named on the cell while the rung is live, which is what the rail's stylesheet colours by */
  id: "archive" | "more";
  label: string;
  icon: IconName;
  item: MenuItem | null;
};

/** The ladder a row slides through: archive, then the whole menu, in one fixed precedence so the
 * hand learns it, and only the rungs the row offers. Archive is the one verb a swipe does on its
 * own: landing is a press read from the composer, where its line says what it will do, and a
 * swipe gives it no such sentence. Read off the row's own menu, so the slide offers exactly what
 * the menu does and nothing twice. */
export function slideLadder(items: MenuEntry[]): Rung[] {
  const archive = items.filter(isItem).find((i) => i.id === "archive") ?? null;
  return [
    ...(archive ? [{ id: "archive" as const, label: archive.label, icon: "archive" as const, item: archive }] : []),
    { id: "more", label: "more", icon: "more", item: null },
  ];
}
