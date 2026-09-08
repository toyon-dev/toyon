import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Theme } from "./index.ts";
import {
  builtinThemes,
  composite,
  contrastFg,
  gruvboxDarkSoft,
  gruvboxLight,
  hex8,
  normalizeHex,
  pairOf,
  pickFamily,
  pickTheme,
  resolveTheme,
  themeColorKeys,
  themeFamilies,
  themeToCssVars,
  vscodeDark2026,
  vscodeLight2026,
} from "./themes.ts";
import { ThemeImportError, vscodeToTheme } from "./vscode-theme.ts";

const fixture = (f: string) => JSON.parse(readFileSync(join(import.meta.dir, "../test/fixtures", f), "utf8"));
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

describe("vscodeToTheme", () => {
  test("full dark theme: precedence + normalized hex everywhere", () => {
    const t = vscodeToTheme(fixture("full-dark.json"), { id: "x" });
    expect(t.name).toBe("Acme Night");
    expect(t.kind).toBe("dark");
    for (const k of themeColorKeys) expect(t.colors[k]).toMatch(HEX);
    expect(t.colors.surface0).toBe("#101418");
    expect(t.colors.surface1).toBe("#0b0e11");
    // translucent hover flattened over surface1, never left with alpha
    expect(t.colors.element0).toBe(composite("#ffffff14", "#0b0e11"));
    expect(t.colors.border1).toBe("#2a3038");
    expect(t.colors.text1).toBe("#8a94a0");
    expect(t.colors.text2).toBe("#5c6670");
    expect(t.colors.orange).toBe("#ff9f43");
    expect(t.colors.purple).toBe("#d19bff");
    expect(t.colors.diffAdd).toBe("#8bd64920");
    expect(themeToCssVars(t)["--scrim"]).toBe(hex8("#101418", 0.7)); // derived, not carried
    expect(t.syntax).toEqual({
      comment: "#5c6670",
      keyword: "#ff6b6b",
      string: "#8bd649",
      number: "#d19bff",
      function: "#5fd7d7",
      variable: "#78a9ff",
    });
  });

  test("sparse light theme: kind from luminance, gaps from defaults, tints derived", () => {
    const t = vscodeToTheme(fixture("sparse-light.json"), { id: "y", name: "Sparse" });
    expect(t.kind).toBe("light");
    expect(t.name).toBe("Sparse");
    for (const k of themeColorKeys) expect(t.colors[k]).toMatch(HEX);
    expect(t.colors.surface1).toBe("#fdf6e3"); // sideBar falls through to editor.background
    expect(t.colors.red).toBe("#dc322f");
    expect(t.colors.blue).toBe("#0451a5"); // Light Modern default
    expect(t.colors.diffAdd).toBe(hex8("#859900", 0.12));
    expect(themeToCssVars(t)["--shadow"]).toBe("#0000002e"); // derived from kind
    expect(t.syntax).toBeUndefined();
  });

  test("rejects non-themes", () => {
    expect(() => vscodeToTheme({ colors: {} }, { id: "z" })).toThrow(ThemeImportError);
    expect(() => vscodeToTheme(null, { id: "z" })).toThrow(ThemeImportError);
  });
});

describe("color helpers", () => {
  test("normalizeHex", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#aabbccff")).toBe("#aabbcc");
    expect(normalizeHex("#aabbcc80")).toBe("#aabbcc80");
    expect(normalizeHex("red")).toBeNull();
  });
  test("contrastFg picks a readable text color", () => {
    expect(contrastFg("#fe8019")).toBe("#1d2021");
    expect(contrastFg("#076678")).toBe("#fbf1c7");
  });
  test("css var names", () => {
    const v = themeToCssVars(gruvboxDarkSoft);
    expect(v["--text1"]).toBe("#a89984");
    expect(v["--diff-add"]).toBe("#b8bb261f");
    // the word weight is the line tint's own alpha scaled, so a theme names one and gets both
    expect(v["--diff-add-word"]).toBe("#b8bb2611");
    expect(v["--accent"]).toBe(gruvboxDarkSoft.colors.orange); // no accent key: orange, as every theme did
    // + accent, sunken, scrim, shadow, a word weight per diff tint, and the seven syntax colours
    expect(Object.keys(v).length).toBe(themeColorKeys.length + 13);
  });
});

describe("pairing", () => {
  const mk = (id: string, name: string, kind: Theme["kind"], source: Theme["source"] = "vscode"): Theme => ({
    ...gruvboxDarkSoft,
    id,
    name,
    kind,
    source,
    pair: undefined,
  });
  const ext = [
    mk("vscode:a.one:one-dark", "One Dark", "dark"),
    mk("vscode:a.one:one-light", "One Light", "light"),
    mk("vscode:b.two:one-light", "One Light", "light"), // same name, other extension
    mk("vscode:a.one:lonely-dark", "Lonely Dark", "dark"),
    mk("file:my-light", "Dracula Light", "light", "file"),
  ];
  const all = [...builtinThemes, ...ext];

  test("explicit pairs on built-ins", () => {
    expect(pairOf(gruvboxDarkSoft, all)?.id).toBe("gruvbox-light");
    expect(pairOf(vscodeLight2026, all)?.id).toBe("vscode-2026-dark");
  });
  test("guessed pairs stay inside the extension and match by dark↔light name swap", () => {
    expect(pairOf(ext[0]!, all)?.id).toBe("vscode:a.one:one-light");
    expect(pairOf(ext[3]!, all)).toBeNull();
    expect(pairOf(ext[4]!, all)).toBeNull();
  });
  test("pickTheme fills the slot + sibling and follows the kind unless in system mode", () => {
    const p0 = { mode: "dark" as const, light: gruvboxLight.id, dark: gruvboxDarkSoft.id };
    expect(pickTheme(p0, vscodeLight2026, all)).toEqual({
      mode: "light",
      light: vscodeLight2026.id,
      dark: vscodeDark2026.id,
    });
    expect(pickTheme({ ...p0, mode: "system" }, ext[3]!, all)).toEqual({
      mode: "system",
      light: gruvboxLight.id,
      dark: "vscode:a.one:lonely-dark",
    });
  });
  test("resolveTheme by appearance", () => {
    const p = { mode: "system" as const, light: "vscode-2026-light", dark: "missing" };
    expect(resolveTheme(p, all, false).id).toBe("vscode-2026-light");
    expect(resolveTheme(p, all, true).id).toBe("toyon-dark"); // unknown falls back to the built-in of that kind
    expect(resolveTheme({ ...p, mode: "light" }, all, true).id).toBe("vscode-2026-light");
  });
});

describe("families", () => {
  const mk = (id: string, name: string, kind: Theme["kind"]): Theme => ({
    ...gruvboxDarkSoft,
    id,
    name,
    kind,
    source: "vscode",
    pair: undefined,
    family: undefined,
  });
  const ext = [
    mk("vscode:a.x:one-dark", "One Dark", "dark"),
    mk("vscode:a.x:one-light", "One Light", "light"),
    mk("vscode:a.x:solo", "Solo Dark", "dark"),
  ];
  test("pairs collapse, singles stand alone, names derive when not explicit", () => {
    const fams = themeFamilies([...builtinThemes, ...ext]);
    const byName = Object.fromEntries(fams.map((f) => [f.name, f]));
    expect(byName.Gruvbox?.dark?.id).toBe("gruvbox-dark-soft");
    expect(byName.Gruvbox?.light?.id).toBe("gruvbox-light");
    expect(byName.Nord?.light).toBeUndefined();
    expect(byName.One?.dark?.id).toBe("vscode:a.x:one-dark");
    expect(byName.One?.light?.id).toBe("vscode:a.x:one-light");
    expect(byName.Solo?.dark?.id).toBe("vscode:a.x:solo");
    // every theme lands in exactly one family
    expect(fams.flatMap((f) => [f.dark, f.light].filter(Boolean)).length).toBe(builtinThemes.length + ext.length);
  });
  test("pickFamily fills the slots it has and keeps appearance unless it can't paint it", () => {
    const fams = themeFamilies(builtinThemes);
    const cat = fams.find((f) => f.name === "Catppuccin")!,
      nord = fams.find((f) => f.name === "Nord")!;
    const p0 = { mode: "light" as const, light: gruvboxLight.id, dark: gruvboxDarkSoft.id };
    expect(pickFamily(p0, cat)).toEqual({ mode: "light", light: "catppuccin-latte", dark: "catppuccin-mocha" });
    expect(pickFamily(p0, nord)).toEqual({ mode: "dark", light: gruvboxLight.id, dark: "nord" });
    expect(pickFamily({ ...p0, mode: "system" }, nord).mode).toBe("system");
  });
});
