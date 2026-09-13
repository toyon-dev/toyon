import { resolveTheme, type ThemePrefs } from "@toyon/shared";
import { grouped, type MenuEntry } from "../../ui/menu.ts";
import { darkNow, type State } from "../store.ts";
import type { Deps } from "./deps.ts";

export const appearanceLabel: Record<ThemePrefs["mode"], string> = {
  dark: "dark",
  light: "light",
  system: "follow system",
  daylight: "follow daylight",
};

/** browser file dialog to raw theme text (the daemon parses JSONC and converts) */
export function pickThemeFile(onText: (name: string, source: string) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.jsonc,application/json";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) f.text().then((source) => onText(f.name, source));
  };
  input.click();
}

export type SettingsState = Pick<
  State,
  "themePrefs" | "themes" | "systemDark" | "daylight" | "agents" | "defaultAgent"
>;

/** What the settings card holds, as a list: the gear's right-click and the palette's settings
 * lines. A picker line carries its current value as the detail, so the menu answers "which one
 * is it now" before it is opened; `sub` says the palette comes back here on Escape. */
export function settingsItems(s: SettingsState, { sock, dispatch }: Deps): MenuEntry[] {
  const prefs = s.themePrefs;
  const themeName = (tid: string) => s.themes.find((t) => t.id === tid)?.name ?? tid;
  return grouped([
    [
      {
        id: "theme",
        label: "theme…",
        detail: resolveTheme(prefs, s.themes, darkNow(s)).name,
        sub: true,
        onClick: () => dispatch({ a: "open", overlay: { kind: "theme", slot: "theme" } }),
      },
      {
        id: "appearance",
        topic: "theme",
        label: "light or dark…",
        detail: appearanceLabel[prefs.mode],
        sub: true,
        onClick: () => dispatch({ a: "open", overlay: { kind: "appearance" } }),
      },
    ],
    [
      {
        id: "agent",
        label: "default agent…",
        detail: s.agents.find((a) => a.id === s.defaultAgent)?.name ?? s.defaultAgent,
        sub: true,
        onClick: () => dispatch({ a: "open", overlay: { kind: "agent" } }),
      },
    ],
    [
      {
        id: "theme-import",
        topic: "theme",
        label: "import a VS Code theme…",
        onClick: () => pickThemeFile((name, source) => sock?.send({ t: "import-theme", name, source })),
      },
      {
        id: "theme-rescan",
        topic: "theme",
        label: "rescan editor themes",
        onClick: () => sock?.send({ t: "rescan-themes" }),
      },
    ],
    // per-slot overrides for mismatched pairs; the picker fills both slots by family so these sit last
    [
      {
        id: "theme-dark",
        topic: "theme",
        label: "dark slot override…",
        detail: themeName(prefs.dark),
        sub: true,
        onClick: () => dispatch({ a: "open", overlay: { kind: "theme", slot: "dark" } }),
      },
      {
        id: "theme-light",
        topic: "theme",
        label: "light slot override…",
        detail: themeName(prefs.light),
        sub: true,
        onClick: () => dispatch({ a: "open", overlay: { kind: "theme", slot: "light" } }),
      },
    ],
  ]);
}
