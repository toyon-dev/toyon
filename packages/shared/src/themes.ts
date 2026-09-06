// Built-in themes + color helpers shared by the daemon (importing/serving) and
// the shell (applying). Every color is #rrggbb or #rrggbbaa.

import type { Theme, ThemeColorKey, ThemePrefs } from "./index.ts";

export const gruvboxDarkSoft: Theme = {
  id: "gruvbox-dark-soft",
  family: "Gruvbox",
  name: "Gruvbox Dark Soft",
  kind: "dark",
  source: "builtin",
  pair: "gruvbox-light",
  colors: {
    bg0: "#32302f",
    bg1: "#3c3836",
    bg2: "#504945",
    bg3: "#665c54",
    fg1: "#ebdbb2",
    fgMuted: "#a89984",
    fgDim: "#928374",
    red: "#fb4934",
    orange: "#fe8019",
    yellow: "#fabd2f",
    green: "#b8bb26",
    aqua: "#8ec07c",
    blue: "#83a598",
    purple: "#d3869b",
    addBg: "#b8bb261f",
    delBg: "#fb49341f",
    scrim: "#282828b3",
    shadow: "#00000066",
  },
  syntax: {
    comment: "#928374",
    keyword: "#fb4934",
    string: "#b8bb26",
    number: "#d3869b",
    type: "#fabd2f",
    function: "#8ec07c",
    variable: "#83a598",
  },
};

// Gruvbox's own light backgrounds are yellow (#fbf1c7 / #f2e5bc); this keeps the
// gruvbox light accents on a neutral warm-gray paper instead.
export const gruvboxLight: Theme = {
  id: "gruvbox-light",
  family: "Gruvbox",
  name: "Gruvbox Light",
  kind: "light",
  source: "builtin",
  pair: "gruvbox-dark-soft",
  colors: {
    bg0: "#f4f2ee",
    bg1: "#ebe8e2",
    bg2: "#dcd8d0",
    bg3: "#c3beb4",
    fg1: "#3c3836",
    fgMuted: "#655f5a",
    fgDim: "#837c74",
    red: "#9d0006",
    orange: "#af3a03",
    yellow: "#b57614",
    green: "#79740e",
    aqua: "#427b58",
    blue: "#076678",
    purple: "#8f3f71",
    addBg: "#79740e26",
    delBg: "#9d000626",
    scrim: "#f4f2eeb3",
    shadow: "#0000002e",
  },
  syntax: {
    comment: "#837c74",
    keyword: "#9d0006",
    string: "#79740e",
    number: "#8f3f71",
    type: "#b57614",
    function: "#427b58",
    variable: "#076678",
  },
};

// VS Code's bundled defaults (MIT, microsoft/vscode extensions/theme-defaults), pre-run through
// vscodeToTheme so they work without an editor installed. Dark/Light Modern were the defaults
// from 2023; Dark/Light 2026 replaced them on main in 2026. Cursor ships its own "Cursor Dark".
export const vscodeDarkModern: Theme = {
  id: "vscode-dark-modern",
  family: "VS Code Modern",
  pair: "vscode-light-modern",
  name: "VS Code Dark Modern",
  kind: "dark",
  source: "builtin",
  colors: {
    bg0: "#1f1f1f",
    bg1: "#181818",
    bg2: "#2a2d2e",
    bg3: "#2b2b2b",
    fg1: "#cccccc",
    fgMuted: "#9d9d9d",
    fgDim: "#6e7681",
    red: "#f85149",
    orange: "#0078d4",
    yellow: "#f5f543",
    green: "#23d18b",
    aqua: "#29b8db",
    blue: "#4daafc",
    purple: "#d670d6",
    addBg: "#23d18b1f",
    delBg: "#f851491f",
    scrim: "#1f1f1fb3",
    shadow: "#00000066",
  },
  syntax: {
    comment: "#6a9955",
    keyword: "#569cd6",
    string: "#ce9178",
    number: "#b5cea8",
    type: "#4ec9b0",
    function: "#dcdcaa",
    variable: "#9cdcfe",
  },
};

export const vscodeLightModern: Theme = {
  id: "vscode-light-modern",
  family: "VS Code Modern",
  pair: "vscode-dark-modern",
  name: "VS Code Light Modern",
  kind: "light",
  source: "builtin",
  colors: {
    bg0: "#ffffff",
    bg1: "#f8f8f8",
    bg2: "#f2f2f2",
    bg3: "#e5e5e5",
    fg1: "#3b3b3b",
    fgMuted: "#3b3b3b",
    fgDim: "#6e7681",
    red: "#f85149",
    orange: "#005fb8",
    yellow: "#949800",
    green: "#00bc00",
    aqua: "#0598bc",
    blue: "#005fb8",
    purple: "#bc05bc",
    addBg: "#00bc001f",
    delBg: "#f851491f",
    scrim: "#ffffffb3",
    shadow: "#0000002e",
  },
  syntax: {
    comment: "#008000",
    keyword: "#0000ff",
    string: "#a31515",
    number: "#098658",
    type: "#267f99",
    function: "#795e26",
    variable: "#001080",
  },
};

export const vscodeDark2026: Theme = {
  id: "vscode-2026-dark",
  family: "VS Code 2026",
  pair: "vscode-2026-light",
  name: "VS Code Dark 2026",
  kind: "dark",
  source: "builtin",
  colors: {
    bg0: "#121314",
    bg1: "#191a1b",
    bg2: "#2b2c2d",
    bg3: "#2a2b2c",
    fg1: "#bbbebf",
    fgMuted: "#8c8c8c",
    fgDim: "#555555",
    red: "#f48771",
    orange: "#2d6e8a",
    yellow: "#e5ba7d",
    green: "#73c991",
    aqua: "#29b8db",
    blue: "#48a0c7",
    purple: "#d670d6",
    addBg: "#347d3926",
    delBg: "#c93c3726",
    scrim: "#121314b3",
    shadow: "#00000066",
  },
  syntax: {
    comment: "#8b949e",
    keyword: "#ff7b72",
    string: "#a5d6ff",
    number: "#b5cea8",
    type: "#4ec9b0",
    function: "#dcdcaa",
    variable: "#ffa657",
  },
};

export const vscodeLight2026: Theme = {
  id: "vscode-2026-light",
  family: "VS Code 2026",
  pair: "vscode-2026-dark",
  name: "VS Code Light 2026",
  kind: "light",
  source: "builtin",
  colors: {
    bg0: "#ffffff",
    bg1: "#fafafd",
    bg2: "#e6e6e9",
    bg3: "#f0f1f2",
    fg1: "#202020",
    fgMuted: "#606060",
    fgDim: "#bbbbbb",
    red: "#ad0707",
    orange: "#0069cc",
    yellow: "#667309",
    green: "#587c0c",
    aqua: "#0598bc",
    blue: "#0069cc",
    purple: "#bc05bc",
    addBg: "#587c0c26",
    delBg: "#ad070726",
    scrim: "#ffffffb3",
    shadow: "#0000002e",
  },
  syntax: {
    comment: "#6e7781",
    keyword: "#cf222e",
    string: "#0a3069",
    number: "#098658",
    type: "#267f99",
    function: "#795e26",
    variable: "#953800",
  },
};

// Popular community themes (all MIT), converted once through vscodeToTheme from their upstream
// theme JSON — Tokyo Night (enkia), Rosé Pine, One Dark Pro (Binaryify) + One Light (akamud),
// Solarized (VS Code's bundled copies), Nord — and Catppuccin built straight from its palette.
export const tokyoNight: Theme = {
  id: "tokyo-night",
  family: "Tokyo Night",
  name: "Tokyo Night",
  kind: "dark",
  source: "builtin",
  pair: "tokyo-night-light",
  colors: {
    bg0: "#1a1b26",
    bg1: "#16161e",
    bg2: "#13131a",
    bg3: "#101014",
    fg1: "#a9b1d6",
    fgMuted: "#515670",
    fgDim: "#545c7e",
    red: "#f7768e",
    orange: "#3d59a1",
    yellow: "#e0af68",
    green: "#73daca",
    aqua: "#7dcfff",
    blue: "#7aa2f7",
    purple: "#bb9af7",
    addBg: "#41a6b520",
    delBg: "#db4b4b22",
    scrim: "#1a1b26b3",
    shadow: "#00000066",
  },
  syntax: {
    comment: "#51597d",
    keyword: "#bb9af7",
    string: "#9ece6a",
    number: "#ff9e64",
    type: "#0db9d7",
    function: "#0db9d7",
    variable: "#c0caf5",
  },
};

export const tokyoNightLight: Theme = {
  id: "tokyo-night-light",
  family: "Tokyo Night",
  name: "Tokyo Night Light",
  kind: "light",
  source: "builtin",
  pair: "tokyo-night",
  colors: {
    bg0: "#e6e7ed",
    bg1: "#d6d8df",
    bg2: "#e1e2e8",
    bg3: "#c1c2c7",
    fg1: "#343b59",
    fgMuted: "#707280",
    fgDim: "#707280",
    red: "#8c4351",
    orange: "#2959aa",
    yellow: "#8f5e15",
    green: "#33635c",
    aqua: "#006c86",
    blue: "#2959aa",
    purple: "#7b43ba",
    addBg: "#2d9c9120",
    delBg: "#e8686812",
    scrim: "#e6e7edb3",
    shadow: "#0000002e",
  },
  syntax: {
    comment: "#888b94",
    keyword: "#65359d",
    string: "#385f0d",
    number: "#965027",
    type: "#006c86",
    function: "#006c86",
    variable: "#343b58",
  },
};

export const rosePine: Theme = {
  id: "rose-pine",
  family: "Rosé Pine",
  name: "Rosé Pine",
  kind: "dark",
  source: "builtin",
  pair: "rose-pine-dawn",
  colors: {
    bg0: "#191724",
    bg1: "#191724",
    bg2: "#221f2e",
    bg3: "#191724",
    fg1: "#e0def4",
    fgMuted: "#908caa",
    fgDim: "#908caa",
    red: "#eb6f92",
    orange: "#ebbcba",
    yellow: "#f6c177",
    green: "#31748f",
    aqua: "#ebbcba",
    blue: "#9ccfd8",
    purple: "#c4a7e7",
    addBg: "#9ccfd826",
    delBg: "#eb6f9226",
    scrim: "#191724b3",
    shadow: "#00000066",
  },
  syntax: {
    comment: "#6e6a86",
    keyword: "#31748f",
    string: "#f6c177",
    number: "#ebbcba",
    type: "#9ccfd8",
    function: "#eb6f92",
    variable: "#ebbcba",
  },
};

export const rosePineDawn: Theme = {
  id: "rose-pine-dawn",
  family: "Rosé Pine",
  name: "Rosé Pine Dawn",
  kind: "light",
  source: "builtin",
  pair: "rose-pine",
  colors: {
    bg0: "#faf4ed",
    bg1: "#faf4ed",
    bg2: "#f3ede8",
    bg3: "#faf4ed",
    fg1: "#575279",
    fgMuted: "#797593",
    fgDim: "#797593",
    red: "#b4637a",
    orange: "#d7827e",
    yellow: "#ea9d34",
    green: "#286983",
    aqua: "#d7827e",
    blue: "#56949f",
    purple: "#907aa9",
    addBg: "#56949f26",
    delBg: "#b4637a26",
    scrim: "#faf4edb3",
    shadow: "#0000002e",
  },
  syntax: {
    comment: "#9893a5",
    keyword: "#286983",
    string: "#ea9d34",
    number: "#d7827e",
    type: "#56949f",
    function: "#b4637a",
    variable: "#d7827e",
  },
};

export const oneDarkPro: Theme = {
  id: "one-dark-pro",
  family: "One Dark Pro",
  name: "One Dark Pro",
  kind: "dark",
  source: "builtin",
  pair: "one-light",
  colors: {
    bg0: "#282c34",
    bg1: "#21252b",
    bg2: "#2c313a",
    bg3: "#3e4452",
    fg1: "#abb2bf",
    fgMuted: "#abb2bf",
    fgDim: "#495162",
    red: "#e05561",
    orange: "#4d78cc",
    yellow: "#d18f52",
    green: "#8cc265",
    aqua: "#42b3c2",
    blue: "#4aa5f0",
    purple: "#c162de",
    addBg: "#00809b33",
    delBg: "#e055611f",
    scrim: "#282c34b3",
    shadow: "#00000066",
  },
  syntax: {
    comment: "#7f848e",
    keyword: "#c678dd",
    string: "#98c379",
    number: "#d19a66",
    type: "#e5c07b",
    function: "#56b6c2",
    variable: "#e06c75",
  },
};

export const oneLight: Theme = {
  id: "one-light",
  family: "One Dark Pro",
  name: "One Light",
  kind: "light",
  source: "builtin",
  pair: "one-dark-pro",
  colors: {
    bg0: "#fafafa",
    bg1: "#eaeaeb",
    bg2: "#e4e4e5",
    bg3: "#e5e5e6",
    fg1: "#383a42",
    fgMuted: "#3b3b3b",
    fgDim: "#9d9d9f",
    red: "#cd3131",
    orange: "#526fff",
    yellow: "#949800",
    green: "#00bc00",
    aqua: "#0598bc",
    blue: "#0451a5",
    purple: "#bc05bc",
    addBg: "#00809b33",
    delBg: "#cd31311f",
    scrim: "#fafafab3",
    shadow: "#0000002e",
  },
  syntax: {
    comment: "#a0a1a7",
    keyword: "#a626a4",
    string: "#50a14f",
    number: "#986801",
    type: "#0184bc",
    function: "#0184bc",
    variable: "#e45649",
  },
};

export const solarizedDark: Theme = {
  id: "solarized-dark",
  family: "Solarized",
  name: "Solarized Dark",
  kind: "dark",
  source: "builtin",
  pair: "solarized-light",
  colors: {
    bg0: "#002b36",
    bg1: "#00212b",
    bg2: "#003846",
    bg3: "#2b2b4a",
    fg1: "#839496",
    fgMuted: "#93a1a1",
    fgDim: "#4a6166",
    red: "#dc322f",
    orange: "#197271",
    yellow: "#b58900",
    green: "#859900",
    aqua: "#2aa198",
    blue: "#268bd2",
    purple: "#d33682",
    addBg: "#8599001f",
    delBg: "#dc322f1f",
    scrim: "#002b36b3",
    shadow: "#00000066",
  },
  syntax: {
    comment: "#586e75",
    keyword: "#859900",
    string: "#2aa198",
    number: "#d33682",
    type: "#859900",
    function: "#268bd2",
    variable: "#268bd2",
  },
};

export const solarizedLight: Theme = {
  id: "solarized-light",
  family: "Solarized",
  name: "Solarized Light",
  kind: "light",
  source: "builtin",
  pair: "solarized-dark",
  colors: {
    bg0: "#fdf6e3",
    bg1: "#eee8d5",
    bg2: "#eae0c0",
    bg3: "#ddd6c1",
    fg1: "#657b83",
    fgMuted: "#586e75",
    fgDim: "#a3aba5",
    red: "#dc322f",
    orange: "#b58900",
    yellow: "#b58900",
    green: "#859900",
    aqua: "#2aa198",
    blue: "#268bd2",
    purple: "#d33682",
    addBg: "#8599001f",
    delBg: "#dc322f1f",
    scrim: "#fdf6e3b3",
    shadow: "#0000002e",
  },
  syntax: {
    comment: "#93a1a1",
    keyword: "#859900",
    string: "#2aa198",
    number: "#d33682",
    type: "#859900",
    function: "#268bd2",
    variable: "#268bd2",
  },
};

export const nord: Theme = {
  id: "nord",
  family: "Nord",
  name: "Nord",
  kind: "dark",
  source: "builtin",
  colors: {
    bg0: "#2e3440",
    bg1: "#2e3440",
    bg2: "#3b4252",
    bg3: "#3b4252",
    fg1: "#d8dee9",
    fgMuted: "#c7cdd8",
    fgDim: "#4c566a",
    red: "#bf616a",
    orange: "#88c0d0",
    yellow: "#ebcb8b",
    green: "#a3be8c",
    aqua: "#88c0d0",
    blue: "#81a1c1",
    purple: "#b48ead",
    addBg: "#81a1c133",
    delBg: "#bf616a4d",
    scrim: "#2e3440b3",
    shadow: "#00000066",
  },
  syntax: {
    comment: "#616e88",
    keyword: "#81a1c1",
    string: "#a3be8c",
    number: "#b48ead",
    type: "#8fbcbb",
    function: "#88c0d0",
    variable: "#d8dee9",
  },
};

export const catppuccinMocha: Theme = {
  id: "catppuccin-mocha",
  family: "Catppuccin",
  name: "Catppuccin Mocha",
  kind: "dark",
  source: "builtin",
  pair: "catppuccin-latte",
  colors: {
    bg0: "#1e1e2e",
    bg1: "#181825",
    bg2: "#313244",
    bg3: "#45475a",
    fg1: "#cdd6f4",
    fgMuted: "#a6adc8",
    fgDim: "#7f849c",
    red: "#f38ba8",
    orange: "#fab387",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    aqua: "#94e2d5",
    blue: "#89b4fa",
    purple: "#cba6f7",
    addBg: "#a6e3a11f",
    delBg: "#f38ba81f",
    scrim: "#1e1e2eb3",
    shadow: "#00000066",
  },
  syntax: {
    comment: "#9399b2",
    keyword: "#cba6f7",
    string: "#a6e3a1",
    number: "#fab387",
    type: "#f9e2af",
    function: "#89b4fa",
    variable: "#cdd6f4",
  },
};

export const catppuccinLatte: Theme = {
  id: "catppuccin-latte",
  family: "Catppuccin",
  name: "Catppuccin Latte",
  kind: "light",
  source: "builtin",
  pair: "catppuccin-mocha",
  colors: {
    bg0: "#eff1f5",
    bg1: "#e6e9ef",
    bg2: "#ccd0da",
    bg3: "#bcc0cc",
    fg1: "#4c4f69",
    fgMuted: "#6c6f85",
    fgDim: "#8c8fa1",
    red: "#d20f39",
    orange: "#fe640b",
    yellow: "#df8e1d",
    green: "#40a02b",
    aqua: "#179299",
    blue: "#1e66f5",
    purple: "#8839ef",
    addBg: "#40a02b1f",
    delBg: "#d20f391f",
    scrim: "#eff1f5b3",
    shadow: "#0000002e",
  },
  syntax: {
    comment: "#7c7f93",
    keyword: "#8839ef",
    string: "#40a02b",
    number: "#fe640b",
    type: "#df8e1d",
    function: "#1e66f5",
    variable: "#4c4f69",
  },
};

const communityThemes: Theme[] = [
  tokyoNight,
  tokyoNightLight,
  rosePine,
  rosePineDawn,
  oneDarkPro,
  oneLight,
  solarizedDark,
  solarizedLight,
  nord,
  catppuccinMocha,
  catppuccinLatte,
];

export const builtinThemes: Theme[] = [
  gruvboxDarkSoft,
  gruvboxLight,
  vscodeDarkModern,
  vscodeLightModern,
  vscodeDark2026,
  vscodeLight2026,
  ...communityThemes,
];

export const defaultThemePrefs: ThemePrefs = {
  mode: "dark",
  light: gruvboxLight.id,
  dark: gruvboxDarkSoft.id,
};

export const themeColorKeys: ThemeColorKey[] = [
  "bg0",
  "bg1",
  "bg2",
  "bg3",
  "fg1",
  "fgMuted",
  "fgDim",
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "addBg",
  "delBg",
  "scrim",
  "shadow",
];

/** bg0 → --bg0, fgMuted → --fg-muted, addBg → --add-bg */
export function cssVarName(key: ThemeColorKey): string {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

export function themeToCssVars(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of themeColorKeys) out[cssVarName(k)] = theme.colors[k];
  return out;
}

/** which slot the prefs paint right now */
export function effectiveKind(prefs: ThemePrefs, prefersDark: boolean): "dark" | "light" {
  return prefs.mode === "system" ? (prefersDark ? "dark" : "light") : prefs.mode;
}

/** the effective theme; an unknown id falls back to the built-in of that kind */
export function resolveTheme(prefs: ThemePrefs, themes: Theme[], prefersDark: boolean): Theme {
  const kind = effectiveKind(prefs, prefersDark);
  return themes.find((t) => t.id === prefs[kind]) ?? builtinThemes.find((t) => t.kind === kind) ?? gruvboxDarkSoft;
}

/** the opposite-kind sibling: explicit `pair`, else a same-source theme whose name differs only by dark↔light */
export function pairOf(theme: Theme, themes: Theme[]): Theme | null {
  if (theme.pair) {
    const t = themes.find((x) => x.id === theme.pair);
    if (t && t.kind !== theme.kind) return t;
  }
  const want = theme.kind === "dark" ? "light" : "dark";
  const key = (n: string) =>
    n
      .toLowerCase()
      .replace(/\b(dark|light)\b/g, "*")
      .replace(/\s+/g, " ")
      .trim();
  const mine = key(theme.name);
  if (!mine.includes("*")) return null;
  // discovered themes only pair inside their own extension ("vscode:<ext>:<slug>")
  const scope = theme.id.startsWith("vscode:") ? theme.id.slice(0, theme.id.lastIndexOf(":") + 1) : null;
  return (
    themes.find(
      (t) => t.kind === want && t.source === theme.source && (!scope || t.id.startsWith(scope)) && key(t.name) === mine,
    ) ?? null
  );
}

export interface ThemeFamily {
  name: string;
  dark?: Theme;
  light?: Theme;
}

/** picker rows: a dark/light pair collapses into one family; singles stand alone */
export function themeFamilies(themes: Theme[]): ThemeFamily[] {
  const out: ThemeFamily[] = [];
  const seen = new Set<string>();
  const derive = (t: Theme) =>
    t.family ??
    (t.name
      .replace(/\b(dark|light)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim() ||
      t.name);
  for (const t of themes) {
    if (seen.has(t.id)) continue;
    const sib = pairOf(t, themes);
    const fam: ThemeFamily = { name: derive(t) };
    fam[t.kind] = t;
    seen.add(t.id);
    if (sib) {
      fam[sib.kind] = sib;
      seen.add(sib.id);
    }
    out.push(fam);
  }
  return out;
}

/** choose a family: fills every slot it has; a fixed appearance the family can't paint follows the kind it does have */
export function pickFamily(prefs: ThemePrefs, fam: ThemeFamily): ThemePrefs {
  const next: ThemePrefs = { ...prefs };
  if (fam.dark) next.dark = fam.dark.id;
  if (fam.light) next.light = fam.light.id;
  if (next.mode !== "system" && !fam[next.mode]) next.mode = fam.dark ? "dark" : "light";
  return next;
}

/** choose a theme: fills its kind's slot (and the sibling's, when known); a fixed appearance follows the theme's kind */
export function pickTheme(prefs: ThemePrefs, theme: Theme, themes: Theme[]): ThemePrefs {
  const next: ThemePrefs = { ...prefs, [theme.kind]: theme.id };
  const sib = pairOf(theme, themes);
  if (sib) next[sib.kind] = sib.id;
  if (next.mode !== "system") next.mode = theme.kind;
  return next;
}

// ---- color math ----

/** "#abc", "#aabbcc", "#aabbccdd" → [r, g, b, a(0..1)]; null for anything else */
export function parseHex(s: string): [number, number, number, number] | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(s.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

/** canonical lowercase #rrggbb / #rrggbbaa (alpha dropped when fully opaque) */
export function normalizeHex(s: string): string | null {
  const c = parseHex(s);
  if (!c) return null;
  return toHex(c[0], c[1], c[2], c[3]);
}

export function toHex(r: number, g: number, b: number, a = 1): string {
  const h = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${a >= 1 ? "" : h(a * 255)}`;
}

/** same rgb with the given alpha */
export function hex8(hex: string, alpha: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return toHex(c[0], c[1], c[2], alpha);
}

/** the color's own alpha scaled by `factor` (clamped to 1) */
export function scaleAlpha(hex: string, factor: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return toHex(c[0], c[1], c[2], Math.min(1, c[3] * factor));
}

/** flatten a translucent color onto an opaque backdrop */
export function composite(fg: string, bg: string): string {
  const f = parseHex(fg),
    b = parseHex(bg);
  if (!f || !b) return fg;
  const a = f[3];
  return toHex(f[0] * a + b[0] * (1 - a), f[1] * a + b[1] * (1 - a), f[2] * a + b[2] * (1 - a));
}

/** relative luminance (sRGB), 0..1 — ignores alpha */
export function luminance(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 0;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio, 1..21 */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a),
    lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDark(hex: string): boolean {
  return luminance(hex) < 0.4;
}

/** readable text color for a badge painted in `bg` (0.179: where black and white contrast equally) */
export function contrastFg(bg: string): string {
  return luminance(bg) > 0.179 ? "#1d2021" : "#fbf1c7";
}
