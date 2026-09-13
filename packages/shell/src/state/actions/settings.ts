import { resolveTheme, type ThemePrefs } from "@toyon/shared";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
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
  "themePrefs" | "themes" | "systemDark" | "daylight" | "agents" | "defaultAgent" | "prefs"
>;

/** the one switch on what a recap costs: on, the agent's quick model writes a sentence; off, the
 * facts alone and never a model call. Here, on the settings card, and on the recap line itself.
 * It names what pressing it does rather than carrying a check: the palette reads a checked item as
 * the choice already in effect and leaves it out, which would hide the way back. */
export function recapsItem(s: Pick<State, "prefs">, { sock }: Pick<Deps, "sock">): MenuItem {
  const on = s.prefs.recaps === "summarize";
  return {
    id: "recaps",
    label: on ? "stop summarizing recaps" : "summarize recaps",
    onClick: () => sock?.send({ t: "set-prefs", prefs: { recaps: on ? "facts" : "summarize" } }),
  };
}

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
    [recapsItem(s, { sock })],
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
