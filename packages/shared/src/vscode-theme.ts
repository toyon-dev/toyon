// VS Code color theme → Orchardist Theme. Pure: takes already-parsed JSON
// (the daemon handles JSONC and `include` resolution).
//
// Workbench colors map onto the ~18-key contract by a fallback chain per key;
// anything missing comes from a small default table (VS Code's Dark/Light
// Modern values for just the keys we read). Token colors are picked from
// tokenColors by TextMate scope prefix — Monaco can't consume TextMate scopes
// directly, so a coarse mapping is all we carry.

import type { Theme, ThemeColorKey, ThemeSyntaxToken } from "./index.ts";
import { composite, contrastRatio, hex8, isDark, normalizeHex, parseHex } from "./themes.ts";

export interface VsCodeThemeJson {
  name?: string;
  type?: string;
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: Array<{ scope?: string | string[]; settings?: { foreground?: string } }> | string;
}

const workbenchKeys: Record<Exclude<ThemeColorKey, "scrim" | "shadow">, string[]> = {
  bg0: ["editor.background"],
  bg1: ["sideBar.background", "activityBar.background", "editor.background"],
  bg2: ["list.hoverBackground", "list.activeSelectionBackground", "editor.selectionBackground"],
  bg3: ["panel.border", "sideBar.border", "editorWidget.border", "widget.border", "editorLineNumber.foreground"],
  fg1: ["editor.foreground", "foreground"],
  fgMuted: ["descriptionForeground", "sideBar.foreground", "tab.inactiveForeground"],
  fgDim: ["disabledForeground", "editorLineNumber.foreground", "editorWhitespace.foreground"],
  red: ["terminal.ansiRed", "errorForeground", "gitDecoration.deletedResourceForeground"],
  green: ["terminal.ansiGreen", "gitDecoration.addedResourceForeground"],
  yellow: ["terminal.ansiYellow", "editorWarning.foreground", "gitDecoration.modifiedResourceForeground"],
  blue: ["terminal.ansiBlue", "textLink.foreground"],
  aqua: ["terminal.ansiCyan", "terminal.ansiBrightCyan"],
  purple: ["terminal.ansiMagenta", "terminal.ansiBrightMagenta"],
  // the accent: first candidate that actually stands out from the editor background (focusBorder is
  // often a subtle border; badges/buttons/links carry the brand color)
  orange: [
    "activityBarBadge.background",
    "button.background",
    "progressBar.background",
    "focusBorder",
    "textLink.foreground",
    "terminal.ansiYellow",
  ],
  addBg: ["diffEditor.insertedLineBackground", "diffEditor.insertedTextBackground"],
  delBg: ["diffEditor.removedLineBackground", "diffEditor.removedTextBackground"],
};

/** VS Code Dark Modern / Light Modern, only the keys we read */
const defaults: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    "editor.background": "#1f1f1f",
    "editor.foreground": "#cccccc",
    "sideBar.background": "#181818",
    "list.hoverBackground": "#2a2d2e",
    "panel.border": "#2b2b2b",
    descriptionForeground: "#9d9d9d",
    disabledForeground: "#7f7f7f",
    "terminal.ansiRed": "#f14c4c",
    "terminal.ansiGreen": "#23d18b",
    "terminal.ansiYellow": "#f5f543",
    "terminal.ansiBlue": "#3b8eea",
    "terminal.ansiCyan": "#29b8db",
    "terminal.ansiMagenta": "#d670d6",
    focusBorder: "#0078d4",
  },
  light: {
    "editor.background": "#ffffff",
    "editor.foreground": "#3b3b3b",
    "sideBar.background": "#f8f8f8",
    "list.hoverBackground": "#f2f2f2",
    "panel.border": "#e5e5e5",
    descriptionForeground: "#3b3b3b",
    disabledForeground: "#a0a0a0",
    "terminal.ansiRed": "#cd3131",
    "terminal.ansiGreen": "#00bc00",
    "terminal.ansiYellow": "#949800",
    "terminal.ansiBlue": "#0451a5",
    "terminal.ansiCyan": "#0598bc",
    "terminal.ansiMagenta": "#bc05bc",
    focusBorder: "#005fb8",
  },
};

const syntaxScopes: Record<ThemeSyntaxToken, string[]> = {
  comment: ["comment"],
  keyword: ["keyword"],
  string: ["string"],
  number: ["constant.numeric"],
  type: ["entity.name.type", "support.type"],
  function: ["entity.name.function", "support.function"],
  variable: ["variable"],
};

export class ThemeImportError extends Error {}

export function vscodeToTheme(json: unknown, opts: { id: string; name?: string; source?: Theme["source"] }): Theme {
  const t = (json ?? {}) as VsCodeThemeJson;
  const colors = t.colors && typeof t.colors === "object" ? t.colors : null;
  if (!colors || !normalizeHex(colors["editor.background"] ?? "")) {
    throw new ThemeImportError('not a VS Code color theme: no colors["editor.background"]');
  }
  // the editor background is the ground truth: some theme files declare the wrong `type`
  // (Tokyo Night Light ships "dark" and relies on its manifest's uiTheme to fix it)
  const kind: Theme["kind"] = isDark(colors["editor.background"]!) ? "dark" : "light";
  const table = defaults[kind];

  const lookup = (keys: string[]): string | null => {
    for (const k of keys) {
      const v = colors[k];
      if (typeof v === "string") {
        const n = normalizeHex(v);
        if (n) return n;
      }
    }
    for (const k of keys) {
      const v = table[k];
      if (v) return v;
    }
    return null;
  };

  const bg0 = lookup(workbenchKeys.bg0)!;
  const bg1 = lookup(workbenchKeys.bg1) ?? bg0;
  // hover/selection colors are often translucent — flatten so panels stay opaque
  const bg2 = opaque(lookup(workbenchKeys.bg2) ?? bg1, bg1);
  const bg3 = opaque(lookup(workbenchKeys.bg3) ?? bg2, bg1);
  const fg1 = lookup(workbenchKeys.fg1)!;
  const fgMuted = opaque(lookup(workbenchKeys.fgMuted) ?? fg1, bg1);
  const fgDim = opaque(lookup(workbenchKeys.fgDim) ?? fgMuted, bg1);
  const accent = (k: keyof typeof workbenchKeys) => opaque(lookup(workbenchKeys[k])!, bg0);
  const red = accent("red"),
    green = accent("green"),
    yellow = accent("yellow");
  const blue = accent("blue"),
    aqua = accent("aqua"),
    purple = accent("purple");
  const orange =
    workbenchKeys.orange
      .map((k) => (typeof colors[k] === "string" ? normalizeHex(colors[k]!) : null))
      .filter((c): c is string => !!c)
      .map((c) => opaque(c, bg0))
      .find((c) => contrastRatio(c, bg0) >= 2.5) ?? accent("yellow");

  const theme: Theme = {
    id: opts.id,
    name: opts.name ?? t.name ?? opts.id,
    kind,
    source: opts.source ?? "vscode",
    colors: {
      bg0,
      bg1,
      bg2,
      bg3,
      fg1,
      fgMuted,
      fgDim,
      red,
      orange,
      yellow,
      green,
      aqua,
      blue,
      purple,
      addBg: lookup(workbenchKeys.addBg) ?? hex8(green, 0.12),
      delBg: lookup(workbenchKeys.delBg) ?? hex8(red, 0.12),
      scrim: hex8(bg0, 0.7),
      shadow: kind === "dark" ? "#00000066" : "#0000002e",
    },
  };

  const syntax = pickSyntax(t.tokenColors);
  if (syntax) theme.syntax = syntax;
  return theme;
}

function opaque(color: string, over: string): string {
  const c = parseHex(color);
  return c && c[3] < 1 ? composite(color, over) : color;
}

function pickSyntax(tokenColors: VsCodeThemeJson["tokenColors"]): Theme["syntax"] | null {
  if (!Array.isArray(tokenColors)) return null;
  const out: NonNullable<Theme["syntax"]> = {};
  for (const [token, wanted] of Object.entries(syntaxScopes) as Array<[ThemeSyntaxToken, string[]]>) {
    // the most general matching scope wins ("keyword" over "keyword.other.unit"); on a tie the
    // later rule wins, which is VS Code's own precedence and keeps includes' children on top
    let best: { fg: string; len: number } | null = null;
    for (const entry of tokenColors) {
      const fg = entry?.settings?.foreground;
      if (!fg) continue;
      const scopes =
        typeof entry.scope === "string" ? entry.scope.split(",").map((s) => s.trim()) : (entry.scope ?? []);
      for (const s of scopes) {
        if (!wanted.some((w) => s === w || s.startsWith(`${w}.`))) continue;
        const n = normalizeHex(fg);
        if (n && (!best || s.length <= best.len)) best = { fg: n, len: s.length };
      }
    }
    if (best) out[token] = best.fg;
  }
  return Object.keys(out).length ? out : null;
}

/** "One Dark Pro" → "one-dark-pro" */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "theme"
  );
}
