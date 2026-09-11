import { describe, expect, test } from "bun:test";
import type { AgentInfo, Theme } from "@toyon/shared";
import { isItem } from "../../ui/menu.ts";
import { recapsItem, settingsItems } from "./settings.ts";

const theme = (id: string, name: string, kind: Theme["kind"]): Theme => ({ id, name, kind }) as Theme;

describe("the settings menu", () => {
  test("names each picker's current value and groups the slot overrides last", () => {
    const items = settingsItems(
      {
        themePrefs: { mode: "system", dark: "t-dark", light: "t-light" },
        themes: [theme("t-dark", "Night", "dark"), theme("t-light", "Day", "light")],
        systemDark: true,
        agents: [{ id: "claude", name: "Claude" } as AgentInfo],
        defaultAgent: "claude",
        prefs: { recaps: "summarize" },
      },
      { sock: null, dispatch: () => {} },
    );
    expect(items.map((i) => (isItem(i) ? `${i.label}${i.detail ? ` [${i.detail}]` : ""}` : "|"))).toEqual([
      "theme… [Night]",
      "light or dark… [follow system]",
      "|",
      "default agent… [Claude]",
      "|",
      "stop summarizing recaps",
      "|",
      "import a VS Code theme…",
      "rescan editor themes",
      "|",
      "dark slot override… [Night]",
      "light slot override… [Day]",
    ]);
    expect(
      items
        .filter(isItem)
        .filter((i) => i.sub)
        .map((i) => i.id),
    ).toEqual(["theme", "appearance", "agent", "theme-dark", "theme-light"]);
    // a switch names what pressing it does, so the palette lists it whichever way it is set
    expect(recapsItem({ prefs: { recaps: "facts" } }, { sock: null }).label).toBe("summarize recaps");
  });
});
