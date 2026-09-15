import { describe, expect, test } from "bun:test";
import type { AgentInfo, Theme, UpdateSettings } from "@toyon/shared";
import { isItem } from "../../ui/menu.ts";
import { settingsItems, updatesDetail, updatesWhy } from "./settings.ts";

describe("the updates row", () => {
  const settings = (over: Partial<UpdateSettings> = {}): UpdateSettings => ({
    mode: "automatic",
    managed: false,
    unreachable: null,
    ...over,
  });

  test("reads the setting, with nothing to explain while nothing holds it back", () => {
    expect(updatesDetail(settings())).toBe("automatic");
    expect(updatesDetail(settings({ mode: "ask" }))).toBe("ask first");
    expect(updatesWhy(settings())).toBeNull();
  });

  test("a registry without toyon is named in the tip, with the way around it left to the person", () => {
    const u = settings({ unreachable: "https://artifacts.example/npm/" });
    expect(updatesDetail(u)).toBe("automatic, can't check");
    expect(updatesWhy(u)).toContain("https://artifacts.example/npm/");
    expect(updatesWhy(u)).toContain("npm install -g toyon --registry=https://registry.npmjs.org/");
    // off asks nothing, so there is nothing to say about the registry
    expect(updatesDetail(settings({ mode: "off", unreachable: "https://artifacts.example/npm/" }))).toBe("off");
  });

  test("turned off for the machine reads as off, whatever the setting", () => {
    const u = settings({ mode: "automatic", managed: true });
    expect(updatesDetail(u)).toBe("off for this machine");
    expect(updatesWhy(u)).toContain("TOYON_UPDATES=off");
  });
});

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
        updates: { mode: "automatic", managed: false, unreachable: null },
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
      "updates [automatic]",
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
});
