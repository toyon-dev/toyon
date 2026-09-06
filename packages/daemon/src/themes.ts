// Theme store: built-ins + ~/.orchardist/themes/*.json + themes contributed by
// extensions installed in VS Code / Cursor / Windsurf (or their app bundles).
// Discovery is read-only; imports from the browser are written to THEMES_DIR
// already converted, so the file is the source of truth from then on.

import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import {
  builtinThemes,
  defaultThemePrefs,
  slug,
  vscodeToTheme,
  ThemeImportError,
  type Theme,
  type ThemePrefs,
} from "@orchardist/shared";
import { THEMES_DIR } from "./paths.ts";
import { cloud } from "./cloud.ts";

const home = homedir();
const defaultExtensionDirs = [
  join(home, ".vscode", "extensions"),
  join(home, ".vscode-insiders", "extensions"),
  join(home, ".vscode-oss", "extensions"),
  join(home, ".cursor", "extensions"),
  join(home, ".windsurf", "extensions"),
  // built-in theme extensions ship inside the app bundles
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
  "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/extensions",
  "/Applications/Cursor.app/Contents/Resources/app/extensions",
  "/Applications/Windsurf.app/Contents/Resources/app/extensions",
  "/usr/share/code/resources/app/extensions",
];

/** colon-separated override (tests, unusual installs); empty string disables discovery */
export function extensionDirs(): string[] {
  const env = process.env.ORCHARDIST_THEME_DIRS;
  if (env != null) return env.split(":").filter(Boolean);
  if (cloud.enabled) return [];
  return defaultExtensionDirs;
}

interface ContributedTheme {
  label?: string;
  uiTheme?: string;
  path?: string;
}

export class ThemeStore {
  themes: Theme[] = builtinThemes;

  constructor(private prefsRef: { get: () => ThemePrefs | undefined; set: (p: ThemePrefs) => void }) {}

  /** saved prefs, normalized: legacy {mode:"fixed",theme} migrated, unknown ids (renamed built-in, uninstalled extension) → slot default */
  get prefs(): ThemePrefs {
    const raw = { ...defaultThemePrefs, ...this.prefsRef.get() } as ThemePrefs & { theme?: string };
    const known = (id: string | undefined) => !!id && this.themes.some((t) => t.id === id);
    let mode: ThemePrefs["mode"] = raw.mode === "system" || raw.mode === "light" ? raw.mode : "dark";
    let light = raw.light,
      dark = raw.dark;
    if ((raw.mode as string) === "fixed" && known(raw.theme)) {
      const t = this.themes.find((x) => x.id === raw.theme)!;
      mode = t.kind;
      if (t.kind === "dark") dark = t.id;
      else light = t.id;
    }
    return {
      mode,
      light: known(light) ? light : defaultThemePrefs.light,
      dark: known(dark) ? dark : defaultThemePrefs.dark,
    };
  }

  setPrefs(p: ThemePrefs) {
    const mode = p.mode === "system" || p.mode === "light" ? p.mode : "dark";
    this.prefsRef.set({ mode, light: p.light, dark: p.dark });
  }

  /** the theme a headless consumer (proxy placeholder page) should paint with */
  current(): Theme {
    const p = this.prefs;
    return this.themes.find((t) => t.id === (p.mode === "light" ? p.light : p.dark)) ?? builtinThemes[0]!;
  }

  load() {
    const seen = new Set<string>();
    const out: Theme[] = [];
    const add = (t: Theme) => {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        out.push(t);
      }
    };
    for (const t of builtinThemes) add(t);
    for (const t of loadDir(THEMES_DIR)) add(t);
    for (const dir of extensionDirs()) for (const t of discover(dir)) add(t);
    this.themes = out;
  }

  /** browser-picked VS Code theme text → converted file in THEMES_DIR; returns the new theme */
  import(name: string, source: string): Theme {
    const json = parseJsonc(source, [], { allowTrailingComma: true });
    if (json && typeof json === "object" && typeof (json as { include?: unknown }).include === "string") {
      throw new ThemeImportError(
        "this theme file uses `include`; drop the whole extension folder's theme into ~/.orchardist/themes or install it in VS Code and rescan",
      );
    }
    const base = slug(basename(name).replace(/\.(json|jsonc)$/i, ""));
    const theme = vscodeToTheme(json, {
      id: `file:${base}`,
      name: (json as { name?: string })?.name ?? base,
      source: "file",
    });
    writeFileSync(join(THEMES_DIR, `${base}.json`), JSON.stringify(theme, null, 2) + "\n");
    this.load();
    return theme;
  }
}

function readJsonc(file: string): unknown {
  return parseJsonc(readFileSync(file, "utf8"), [], { allowTrailingComma: true });
}

/** parse a VS Code theme file, folding in its `include` chain (child keys win) */
export function readVscodeTheme(file: string, depth = 0): Record<string, unknown> {
  const json = readJsonc(file);
  if (!json || typeof json !== "object") throw new ThemeImportError(`${file}: not a JSON object`);
  const t = json as Record<string, unknown>;
  if (typeof t.include === "string" && depth < 5) {
    const parent = readVscodeTheme(resolve(dirname(file), t.include), depth + 1);
    return {
      ...parent,
      ...t,
      colors: { ...((parent.colors as object) ?? {}), ...((t.colors as object) ?? {}) },
      tokenColors: [
        ...(Array.isArray(parent.tokenColors) ? parent.tokenColors : []),
        ...(Array.isArray(t.tokenColors) ? t.tokenColors : []),
      ],
    };
  }
  return t;
}

/** ~/.orchardist/themes: Orchardist Theme JSON (has colors.bg0) or raw VS Code JSON */
function loadDir(dir: string): Theme[] {
  if (!existsSync(dir)) return [];
  const out: Theme[] = [];
  for (const f of readdirSync(dir)) {
    if (!/\.jsonc?$/i.test(f)) continue;
    const file = join(dir, f);
    const id = `file:${slug(f.replace(/\.(json|jsonc)$/i, ""))}`;
    try {
      const json = readJsonc(file) as { colors?: Record<string, string>; name?: string; kind?: string };
      if (json?.colors && typeof json.colors.bg0 === "string") {
        out.push({ ...(json as unknown as Theme), id, source: "file" });
      } else {
        out.push(vscodeToTheme(readVscodeTheme(file), { id, source: "file" }));
      }
    } catch (e) {
      console.warn(`[themes] skipping ${file}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}

/** every `contributes.themes` entry under an extensions dir */
function discover(dir: string): Theme[] {
  if (!existsSync(dir)) return [];
  const out: Theme[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const extDir = join(dir, name);
    const pkgFile = join(extDir, "package.json");
    try {
      if (!statSync(extDir).isDirectory() || !existsSync(pkgFile)) continue;
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as {
        name?: string;
        publisher?: string;
        contributes?: { themes?: ContributedTheme[] };
      };
      const themes = pkg.contributes?.themes;
      if (!Array.isArray(themes)) continue;
      const ext = `${pkg.publisher ?? "local"}.${pkg.name ?? name}`;
      // built-in extensions localize labels: "%darkModernThemeLabel%" → package.nls.json
      let nls: Record<string, string> = {};
      const nlsFile = join(extDir, "package.nls.json");
      if (existsSync(nlsFile)) {
        try {
          nls = JSON.parse(readFileSync(nlsFile, "utf8"));
        } catch {}
      }
      for (const c of themes) {
        if (!c.path || !c.label) continue;
        const m = /^%(.+)%$/.exec(c.label);
        if (m) c.label = nls[m[1]!] ?? m[1]!;
        const file = resolve(extDir, c.path);
        try {
          const json = readVscodeTheme(file);
          out.push(vscodeToTheme(json, { id: `vscode:${ext}:${slug(c.label)}`, name: c.label, source: "vscode" }));
        } catch (e) {
          console.warn(`[themes] skipping ${file}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (e) {
      console.warn(`[themes] skipping ${extDir}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}
