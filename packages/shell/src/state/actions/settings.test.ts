import { describe, expect, test } from "bun:test";
import type { AgentInfo, Theme } from "@toyon/shared";
import { isItem } from "../../ui/menu.ts";
import { settingsItems } from "./settings.ts";

const theme = (id: string, name: string, kind: Theme["kind"]): Theme => ({ id, name, kind }) as Theme;

describe("the settings menu", () => {
  test("names each picker's current value and groups the slot overrides last", () => {
    const items = settingsItems(
      {
        themePrefs: { mode: "system", dark: "t-dark", light: "t-light" },
        themes: [theme("t-dark", "Night", "dark"), theme("t-light", "Day", "light")],
        systemDark: true,
        daylight: null,
        agents: [{ id: "claude", name: "Claude" } as AgentInfo],
        defaultAgent: "claude",
        chatSide: "left",
        keepAwake: null,
      },
      { sock: null, dispatch: () => {} },
    );
    // the topic is the palette's word for the theme cluster, the menu's rule does that job there
    const line = (i: (typeof items)[number]) =>
      isItem(i) ? `${i.topic ? `${i.topic}: ` : ""}${i.label}${i.detail ? ` [${i.detail}]` : ""}` : "|";
    expect(items.map(line)).toEqual([
      "theme… [Night]",
      "theme: light or dark… [follow system]",
      "|",
      "default agent… [Claude]",
      "|",
      "chat side [left]",
      "|",
      "theme: import a VS Code theme…",
      "theme: rescan editor themes",
      "|",
      "theme: dark slot override… [Night]",
      "theme: light slot override… [Day]",
    ]);
    expect(
      items
        .filter(isItem)
        .filter((i) => i.sub)
        .map((i) => i.id),
    ).toEqual(["theme", "appearance", "agent", "theme-dark", "theme-light"]);
  });

  test("the keep-awake line shows where the daemon has it, naming the current value", () => {
    const row = (keepAwake: "use" | "always" | "off" | null) =>
      settingsItems(
        {
          themePrefs: { mode: "system", dark: "t-dark", light: "t-light" },
          themes: [],
          systemDark: true,
          daylight: null,
          agents: [],
          defaultAgent: "claude",
          chatSide: "left",
          keepAwake,
        },
        { sock: null, dispatch: () => {} },
      )
        .filter(isItem)
        .find((i) => i.id === "keep-awake");
    expect(row(null)).toBeUndefined();
    expect(row("use")?.detail).toBe("while in use");
    expect(row("always")?.detail).toBe("always");
    expect(row("off")?.detail).toBe("off");
  });
});
