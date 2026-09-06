import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultThemePrefs, gruvboxLight, type ThemePrefs } from "@orchardist/shared";
import { ThemeStore } from "./store.ts";

// extension discovery reads ORCHARDIST_THEME_DIRS at call time; point it at the fixtures
process.env.ORCHARDIST_THEME_DIRS = join(import.meta.dir, "../../test/fixtures/extensions");
const home = mkdtempSync(join(tmpdir(), "orch-themes-"));
const themesDir = join(home, "themes");
mkdirSync(themesDir, { recursive: true });

function makeStore() {
  let prefs: ThemePrefs | undefined;
  const store = new ThemeStore(
    {
      get: () => prefs,
      set: (p) => {
        prefs = p;
      },
    },
    themesDir,
  );
  return { store, prefs: () => prefs };
}

beforeAll(() => {
  const dir = join(themesDir);
  mkdirSync(dir, { recursive: true });
  // already-converted Orchardist theme
  writeFileSync(
    join(dir, "My Light.json"),
    JSON.stringify({ ...gruvboxLight, id: "ignored", name: "My Light", source: "builtin" }),
  );
  // raw VS Code theme dropped in by hand
  writeFileSync(join(dir, "raw.jsonc"), `{ /* raw */ "name": "Raw", "colors": { "editor.background": "#202020" }, }`);
  writeFileSync(join(dir, "junk.json"), `{ "hello": 1 }`);
  writeFileSync(join(dir, "notes.txt"), `not a theme`);
});

describe("ThemeStore", () => {
  test("load: built-ins, THEMES_DIR files, discovered extensions; junk skipped", () => {
    const { store } = makeStore();
    store.load();
    const ids = store.themes.map((t) => t.id);
    expect(ids.slice(0, 2)).toEqual(["gruvbox-dark-soft", "gruvbox-light"]);
    expect(ids).toContain("file:my-light");
    expect(ids).toContain("file:raw");
    expect(ids).not.toContain("file:junk");
    expect(ids).toContain("vscode:acme.orchard-themes:orchard-night");
    expect(ids).toContain("vscode:acme.orchard-themes:orchard-day");
    expect(ids).not.toContain("vscode:acme.orchard-themes:broken");

    const mine = store.themes.find((t) => t.id === "file:my-light")!;
    expect(mine.name).toBe("My Light");
    expect(mine.source).toBe("file");

    const night = store.themes.find((t) => t.id === "vscode:acme.orchard-themes:orchard-night")!;
    expect(night.kind).toBe("dark");
    expect(night.colors.bg0).toBe("#101418"); // from the include
    expect(night.colors.orange).toBe("#ff9f43"); // own key
    expect(night.syntax).toEqual({ comment: "#5c6670", keyword: "#ff6b6b" }); // parent + child tokenColors

    const day = store.themes.find((t) => t.id === "vscode:acme.orchard-themes:orchard-day")!;
    expect(day.kind).toBe("light"); // uiTheme "vs" wins over the dark base
    expect(day.colors.bg0).toBe("#fdf6e3");
  });

  test("prefs default and persist", () => {
    const { store, prefs } = makeStore();
    expect(store.prefs).toEqual(defaultThemePrefs);
    store.setPrefs({ mode: "system", light: "file:my-light", dark: "gruvbox-dark-soft" });
    expect(prefs()?.mode).toBe("system");
    store.load();
    expect(store.current().id).toBe("gruvbox-dark-soft"); // system mode resolves to the dark slot headlessly
    expect(store.prefs.light).toBe("file:my-light");
  });

  test("prefs migrate the legacy fixed/theme shape and drop unknown ids", () => {
    let saved: any = { mode: "fixed", theme: "gruvbox-light", light: "gruvbox-light-soft", dark: "nope" };
    const store = new ThemeStore(
      {
        get: () => saved,
        set: (p) => {
          saved = p;
        },
      },
      themesDir,
    );
    store.load();
    expect(store.prefs).toEqual({ mode: "light", light: "gruvbox-light", dark: "gruvbox-dark-soft" });
  });

  test("import writes a converted file and refuses include", () => {
    const { store } = makeStore();
    const t = store.import(
      "Some Theme.json",
      `{ "name": "Imported", "type": "dark", "colors": { "editor.background": "#111111" } }`,
    );
    expect(t.id).toBe("file:some-theme");
    expect(t.source).toBe("file");
    expect(store.themes.some((x) => x.id === "file:some-theme")).toBe(true);
    expect(() => store.import("inc.json", `{ "include": "./x.json", "colors": {} }`)).toThrow(/include/);
  });
});
