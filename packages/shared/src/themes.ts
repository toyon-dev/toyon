// Built-in themes + color helpers shared by the daemon (importing/serving) and
// the shell (applying). Every color is #rrggbb or #rrggbbaa.

import type { Theme, ThemeColorKey, ThemePrefs } from "./index.ts";

export const gruvboxDarkSoft: Theme = {
  id: "gruvbox-dark-soft",
  name: "Gruvbox Dark Soft",
  kind: "dark",
  source: "builtin",
  pair: "gruvbox-light",
  colors: {
    bg0: "#32302f", bg1: "#3c3836", bg2: "#504945", bg3: "#665c54",
    fg1: "#ebdbb2", fgMuted: "#a89984", fgDim: "#928374",
    red: "#fb4934", orange: "#fe8019", yellow: "#fabd2f", green: "#b8bb26",
    aqua: "#8ec07c", blue: "#83a598", purple: "#d3869b",
    addBg: "#b8bb261f", delBg: "#fb49341f",
    scrim: "#282828b3", shadow: "#00000066",
  },
  syntax: {
    comment: "#928374", keyword: "#fb4934", string: "#b8bb26", number: "#d3869b",
    type: "#fabd2f", function: "#8ec07c", variable: "#83a598",
  },
};

// Gruvbox's own light backgrounds are yellow (#fbf1c7 / #f2e5bc); this keeps the
// gruvbox light accents on a neutral warm-gray paper instead.
export const gruvboxLight: Theme = {
  id: "gruvbox-light",
  name: "Gruvbox Light",
  kind: "light",
  source: "builtin",
  pair: "gruvbox-dark-soft",
  colors: {
    bg0: "#f4f2ee", bg1: "#ebe8e2", bg2: "#dcd8d0", bg3: "#c3beb4",
    fg1: "#3c3836", fgMuted: "#655f5a", fgDim: "#837c74",
    red: "#9d0006", orange: "#af3a03", yellow: "#b57614", green: "#79740e",
    aqua: "#427b58", blue: "#076678", purple: "#8f3f71",
    addBg: "#79740e26", delBg: "#9d000626",
    scrim: "#f4f2eeb3", shadow: "#0000002e",
  },
  syntax: {
    comment: "#837c74", keyword: "#9d0006", string: "#79740e", number: "#8f3f71",
    type: "#b57614", function: "#427b58", variable: "#076678",
  },
};

// VS Code's bundled defaults (MIT, microsoft/vscode extensions/theme-defaults), pre-run through
// vscodeToTheme so they work without an editor installed. Dark/Light Modern were the defaults
// from 2023; Dark/Light 2026 replaced them on main in 2026. Cursor ships its own "Cursor Dark".
export const vscodeDarkModern: Theme = {
  id: "vscode-dark-modern",
  pair: "vscode-light-modern",
  name: "VS Code Dark Modern",
  kind: "dark",
  source: "builtin",
  colors: {
    bg0: "#1f1f1f", bg1: "#181818", bg2: "#2a2d2e", bg3: "#2b2b2b",
    fg1: "#cccccc", fgMuted: "#9d9d9d", fgDim: "#6e7681",
    red: "#f85149", orange: "#0078d4", yellow: "#f5f543", green: "#23d18b",
    aqua: "#29b8db", blue: "#4daafc", purple: "#d670d6",
    addBg: "#23d18b1f", delBg: "#f851491f",
    scrim: "#1f1f1fb3", shadow: "#00000066",
  },
  syntax: {
    comment: "#6a9955", keyword: "#569cd6", string: "#ce9178", number: "#b5cea8",
    type: "#4ec9b0", function: "#dcdcaa", variable: "#9cdcfe",
  },
};

export const vscodeLightModern: Theme = {
  id: "vscode-light-modern",
  pair: "vscode-dark-modern",
  name: "VS Code Light Modern",
  kind: "light",
  source: "builtin",
  colors: {
    bg0: "#ffffff", bg1: "#f8f8f8", bg2: "#f2f2f2", bg3: "#e5e5e5",
    fg1: "#3b3b3b", fgMuted: "#3b3b3b", fgDim: "#6e7681",
    red: "#f85149", orange: "#005fb8", yellow: "#949800", green: "#00bc00",
    aqua: "#0598bc", blue: "#005fb8", purple: "#bc05bc",
    addBg: "#00bc001f", delBg: "#f851491f",
    scrim: "#ffffffb3", shadow: "#0000002e",
  },
  syntax: {
    comment: "#008000", keyword: "#0000ff", string: "#a31515", number: "#098658",
    type: "#267f99", function: "#795e26", variable: "#001080",
  },
};

export const vscodeDark2026: Theme = {
  id: "vscode-2026-dark",
  pair: "vscode-2026-light",
  name: "VS Code Dark 2026",
  kind: "dark",
  source: "builtin",
  colors: {
    bg0: "#121314", bg1: "#191a1b", bg2: "#2b2c2d", bg3: "#2a2b2c",
    fg1: "#bbbebf", fgMuted: "#8c8c8c", fgDim: "#555555",
    red: "#f48771", orange: "#2d6e8a", yellow: "#e5ba7d", green: "#73c991",
    aqua: "#29b8db", blue: "#48a0c7", purple: "#d670d6",
    addBg: "#347d3926", delBg: "#c93c3726",
    scrim: "#121314b3", shadow: "#00000066",
  },
  syntax: {
    comment: "#8b949e", keyword: "#ff7b72", string: "#a5d6ff", number: "#b5cea8",
    type: "#4ec9b0", function: "#dcdcaa", variable: "#ffa657",
  },
};

export const vscodeLight2026: Theme = {
  id: "vscode-2026-light",
  pair: "vscode-2026-dark",
  name: "VS Code Light 2026",
  kind: "light",
  source: "builtin",
  colors: {
    bg0: "#ffffff", bg1: "#fafafd", bg2: "#e6e6e9", bg3: "#f0f1f2",
    fg1: "#202020", fgMuted: "#606060", fgDim: "#bbbbbb",
    red: "#ad0707", orange: "#0069cc", yellow: "#667309", green: "#587c0c",
    aqua: "#0598bc", blue: "#0069cc", purple: "#bc05bc",
    addBg: "#587c0c26", delBg: "#ad070726",
    scrim: "#ffffffb3", shadow: "#0000002e",
  },
  syntax: {
    comment: "#6e7781", keyword: "#cf222e", string: "#0a3069", number: "#098658",
    type: "#267f99", function: "#795e26", variable: "#953800",
  },
};

export const builtinThemes: Theme[] = [
  gruvboxDarkSoft, gruvboxLight,
  vscodeDarkModern, vscodeLightModern, vscodeDark2026, vscodeLight2026,
];

export const defaultThemePrefs: ThemePrefs = {
  mode: "dark",
  light: gruvboxLight.id,
  dark: gruvboxDarkSoft.id,
};

export const themeColorKeys: ThemeColorKey[] = [
  "bg0", "bg1", "bg2", "bg3", "fg1", "fgMuted", "fgDim",
  "red", "orange", "yellow", "green", "aqua", "blue", "purple",
  "addBg", "delBg", "scrim", "shadow",
];

/** bg0 → --bg0, fgMuted → --fg-muted, addBg → --add-bg */
export function cssVarName(key: ThemeColorKey): string {
  return "--" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
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
  const key = (n: string) => n.toLowerCase().replace(/\b(dark|light)\b/g, "*").replace(/\s+/g, " ").trim();
  const mine = key(theme.name);
  if (!mine.includes("*")) return null;
  // discovered themes only pair inside their own extension ("vscode:<ext>:<slug>")
  const scope = theme.id.startsWith("vscode:") ? theme.id.slice(0, theme.id.lastIndexOf(":") + 1) : null;
  return themes.find((t) => t.kind === want && t.source === theme.source && (!scope || t.id.startsWith(scope)) && key(t.name) === mine) ?? null;
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
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
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
  const f = parseHex(fg), b = parseHex(bg);
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

export function isDark(hex: string): boolean {
  return luminance(hex) < 0.4;
}

/** readable text color for a badge painted in `bg` (0.179: where black and white contrast equally) */
export function contrastFg(bg: string): string {
  return luminance(bg) > 0.179 ? "#1d2021" : "#fbf1c7";
}
