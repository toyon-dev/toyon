import { describe, expect, test } from "bun:test";

/**
 * One menu, one way to open it. The drift this stops: a surface keeping a menu in its own
 * `useState` and rendering its own `<Menu>`, which is how the app came to have six of them and
 * two on screen at once (a right-click fires no click, and each menu closed itself on a click).
 * So the primitive is drawn once, by the singleton in ui/Menu.tsx, and a surface reaches the slot
 * only through `useContextMenu`, whose handler is spread onto the row rather than written by hand.
 * The two hand-written handlers are the singleton's own box (a right-click on the menu is not a
 * request for another) and the app root's fallback, which is what makes bare chrome answer.
 */

const SRC = new URL("..", import.meta.url).pathname;

/** `onContextMenu=` written by hand, rather than spread from the hook */
const HAND_WRITTEN_OK = new Set(["ui/Menu.tsx", "app/App.tsx"]);

async function sources(): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })) {
    if (file.endsWith(".test.ts")) continue;
    out.push([file, await Bun.file(`${SRC}${file}`).text()]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

describe("the one context menu", () => {
  test("is drawn by the singleton alone, and every surface opens it through the hook", async () => {
    const offenders: string[] = [];
    for (const [file, src] of await sources()) {
      if (file !== "ui/Menu.tsx" && /<Menu\b/.test(src)) offenders.push(`${file}: renders <Menu>`);
      if (file !== "app/App.tsx" && /\/Menu\.tsx"/.test(src)) offenders.push(`${file}: imports Menu.tsx`);
      if (/useState<(DOMRect|MenuState|\{ *at:)/.test(src)) offenders.push(`${file}: keeps a menu in local state`);
      if (!HAND_WRITTEN_OK.has(file) && file !== "ui/menu.ts" && /onContextMenu=/.test(src)) {
        offenders.push(`${file}: writes onContextMenu by hand`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every row idiom that has actions answers a right-click", async () => {
    // the rows the rulings name (notes/BACKLOG.md "Right-click works everywhere"): each file
    // renders a row with a menu, spread from the hook
    const rows = [
      "surfaces/rail/Rail.tsx",
      "surfaces/changes/GitFileRow.tsx",
      "surfaces/changes/CommitRow.tsx",
      // the terminal's tabs: their menus are the items', spread by the strip they sit in
      "ui/Tabs.tsx",
      "surfaces/chat/ChatItemView.tsx",
      "surfaces/design/DesignPane.tsx",
      "ui/ListPicker.tsx",
    ];
    const missing: string[] = [];
    for (const file of rows) {
      const src = await Bun.file(`${SRC}${file}`).text();
      if (!/\.contextMenu\(/.test(src)) missing.push(file);
    }
    expect(missing).toEqual([]);
  });
});
