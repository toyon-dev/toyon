// The shell's Theme, rendered as a Monaco theme.
//
// Monaco has two colour surfaces and they fail differently. `rules` paint the tokens its monarch
// tokenizers emit, and `colors` paint every piece of chrome the editor draws around them. Nothing
// here inherits: with `inherit: true` every token the theme did not name lands on VS Code Dark+
// (`delimiter` brighter than any Toyon foreground, JSON keys and HTML attributes in Dark+ blue, the
// collapsed-region breadcrumb in Dark+ purple), and a theme's own palette can't fix a colour it was
// never asked for. The empty-token rule is the floor, so a token nobody names lands on the theme's
// own foreground rather than on a constant from another palette.

import type { Theme } from "@toyon/shared";
import { accentKey, hex8, syntaxOf, wordTint } from "@toyon/shared";
import type * as monaco from "monaco-editor";

/** monaco wants token colours bare, workbench colours with the hash */
const bare = (hex: string) => hex.replace("#", "");

export function toMonacoTheme(t: Theme): monaco.editor.IStandaloneThemeData {
  const c = t.colors;
  // syntaxOf, not t.syntax: a theme that named only half its tokens would otherwise leave the rest
  // to Monaco's built-in scheme here and to the chat log's own fallback there, and the same file
  // would come out in two colours depending on which surface you read it in
  const s = syntaxOf(t);
  const accent = c[accentKey(t)];

  // Longest dot-prefix wins and undefined fields fall through to the shorter match, so each entry
  // below covers its whole family: `string` also carries `string.escape` and `string.invalid`,
  // `number` carries the hex/float/binary variants. The families are the seven the Theme contract
  // names, plus the ones a tokenizer emits that have no contract key and would otherwise be text:
  // punctuation, markup tags and attributes, object keys.
  const rules: monaco.editor.ITokenThemeRule[] = [
    { token: "", foreground: bare(c.text0), background: bare(c.surface0) },
    // punctuation is structure, not content: it sits a tier below the code it separates
    { token: "delimiter", foreground: bare(c.text1) },
    { token: "operator", foreground: bare(c.text1) },
    { token: "meta", foreground: bare(c.text1) },
    { token: "white", foreground: bare(c.text2) },
    { token: "identifier", foreground: bare(c.text0) },
    { token: "comment", foreground: bare(s.comment), fontStyle: "italic" },
    { token: "keyword", foreground: bare(s.keyword) },
    // markup: a tag is the keyword of a document, its attributes are its variables
    { token: "tag", foreground: bare(s.keyword) },
    { token: "metatag", foreground: bare(s.keyword) },
    { token: "attribute.name", foreground: bare(s.variable) },
    { token: "attribute.value", foreground: bare(s.string) },
    { token: "key", foreground: bare(s.variable) },
    { token: "string", foreground: bare(s.string) },
    { token: "string.key", foreground: bare(s.variable) },
    { token: "string.value", foreground: bare(s.string) },
    { token: "regexp", foreground: bare(s.string) },
    { token: "number", foreground: bare(s.number) },
    { token: "constant", foreground: bare(s.number) },
    { token: "string.escape", foreground: bare(s.number) },
    { token: "type", foreground: bare(s.type) },
    { token: "annotation", foreground: bare(s.type) },
    { token: "namespace", foreground: bare(s.type) },
    { token: "function", foreground: bare(s.function) },
    { token: "predefined", foreground: bare(s.function) },
    { token: "support", foreground: bare(s.function) },
    { token: "variable", foreground: bare(s.variable) },
    { token: "invalid", foreground: bare(c.red) },
    { token: "emphasis", fontStyle: "italic" },
    { token: "strong", fontStyle: "bold" },
  ];

  return {
    base: t.kind === "light" ? "vs" : "vs-dark",
    inherit: false,
    rules,
    colors: {
      "editor.background": c.surface0,
      "editor.foreground": c.text0,
      "editor.lineHighlightBackground": hex8(c.surface1, 0),
      "editorGutter.background": c.surface0,
      // line numbers are text, so they come off the text ramp; reading them off the border ramp
      // happened to land close in the built-ins and goes wrong the moment a theme's rules are a
      // colour rather than a gray
      "editorLineNumber.foreground": c.text2,
      "editorLineNumber.activeForeground": c.text1,
      "editorCursor.foreground": accent,

      // a selection has to stay legible under the syntax it covers, so it is the chrome's own
      // selection surface rather than the accent: an accent-tinted band restates the hue of half
      // the tokens sitting on it
      "editor.selectionBackground": hex8(c.element1, 0.7),
      "editor.inactiveSelectionBackground": hex8(c.element1, 0.4),
      "editor.selectionHighlightBackground": hex8(c.element1, 0.35),
      "editor.wordHighlightBackground": hex8(c.element0, 0.8),
      "editor.wordHighlightStrongBackground": hex8(c.element1, 0.7),
      "editor.findMatchBackground": hex8(accent, 0.38),
      "editor.findMatchHighlightBackground": hex8(accent, 0.18),
      "editor.rangeHighlightBackground": hex8(c.element0, 0.5),
      "editorBracketMatch.background": hex8(c.element1, 0.5),
      "editorBracketMatch.border": hex8(c.border1, 0),
      "editorIndentGuide.background1": hex8(c.text2, 0.28),
      "editorIndentGuide.activeBackground1": hex8(c.text2, 0.6),
      "editorWhitespace.foreground": hex8(c.text2, 0.45),
      "editorError.foreground": c.red,
      "editorWarning.foreground": c.yellow,
      "editorInfo.foreground": c.blue,
      "editorLink.activeForeground": c.blue,

      // monaco paints .line-insert and .char-insert as separate elements, and on a wholly new line
      // the word-level range covers the whole line, so the two tints composite. wordTint is the
      // fraction that keeps that composite where the chat log's own word blocks sit, and both read
      // it from the same place, so the pane and the log cannot drift apart.
      "diffEditor.insertedTextBackground": wordTint(c.diffAdd),
      "diffEditor.removedTextBackground": wordTint(c.diffDel),
      "diffEditor.insertedLineBackground": c.diffAdd,
      "diffEditor.removedLineBackground": c.diffDel,
      "diffEditorGutter.insertedLineBackground": c.diffAdd,
      "diffEditorGutter.removedLineBackground": c.diffDel,
      "diffEditor.border": c.border0,
      "diffEditor.diagonalFill": hex8(c.border0, 0.6),
      // the "N hidden lines" band sits over the code it hides, so it has to be opaque
      "diffEditor.unchangedRegionBackground": c.surface1,
      "diffEditor.unchangedRegionForeground": c.text2,
      "diffEditor.unchangedCodeBackground": hex8(c.surface0, 0),

      "editorWidget.background": c.surface1,
      "editorWidget.foreground": c.text0,
      "editorWidget.border": c.border0,
      "editorWidget.resizeBorder": c.border1,
      "editorHoverWidget.background": c.surface1,
      "editorHoverWidget.foreground": c.text0,
      "editorHoverWidget.border": c.border0,
      "editorHoverWidget.statusBarBackground": c.surface2,
      "editorSuggestWidget.background": c.surface1,
      "editorSuggestWidget.foreground": c.text0,
      "editorSuggestWidget.border": c.border0,
      "editorSuggestWidget.selectedBackground": c.element1,
      "editorSuggestWidget.selectedForeground": c.text0,
      "editorSuggestWidget.highlightForeground": accent,
      "editorSuggestWidget.focusHighlightForeground": accent,
      "editorStickyScroll.background": c.surface1,
      "editorStickyScrollHover.background": c.element0,

      "menu.background": c.surface2,
      "menu.foreground": c.text0,
      "menu.border": c.border0,
      "menu.selectionBackground": c.element1,
      "menu.selectionForeground": c.text0,
      "menu.separatorBackground": c.border0,
      "input.background": c.surface0,
      "input.foreground": c.text0,
      "input.border": c.border0,
      "input.placeholderForeground": c.text2,
      "inputOption.activeBackground": hex8(accent, 0.2),
      "inputOption.activeBorder": accent,
      "inputOption.activeForeground": c.text0,
      "list.hoverBackground": c.element0,
      "list.focusBackground": c.element1,
      "list.activeSelectionBackground": c.element1,
      "list.activeSelectionForeground": c.text0,
      "list.highlightForeground": accent,
      "toolbar.hoverBackground": c.element0,

      "scrollbarSlider.background": hex8(c.surface2, 0.4),
      "scrollbarSlider.hoverBackground": hex8(c.surface2, 0.6),
      "scrollbarSlider.activeBackground": hex8(c.element1, 0.7),
      "scrollbar.shadow": hex8(c.surface0, 0),

      // the collapsed-region header prints a breadcrumb of codicons, and they are the one place
      // Monaco reaches for the workbench's symbol palette: unnamed, they are Dark+ purple and blue
      // in every theme. Each icon takes the colour its own kind of token has in the pane below.
      ...symbolIcons(s, c.text1),
    },
  };
}

/** every symbolIcon.*Foreground, grouped onto the syntax family the symbol belongs to */
function symbolIcons(s: ReturnType<typeof syntaxOf>, neutral: string): Record<string, string> {
  const families: Array<[string, string[]]> = [
    [s.type, ["class", "interface", "struct", "enumerator", "typeParameter", "event"]],
    [s.function, ["function", "method", "constructor", "operator"]],
    [s.variable, ["variable", "field", "property", "key", "reference"]],
    [s.number, ["constant", "number", "boolean", "enumeratorMember", "unit"]],
    [s.string, ["string", "text", "color"]],
    [s.keyword, ["keyword", "snippet"]],
    [neutral, ["module", "namespace", "package", "file", "folder", "array", "object", "null"]],
  ];
  const out: Record<string, string> = {};
  for (const [color, kinds] of families) for (const k of kinds) out[`symbolIcon.${k}Foreground`] = color;
  return out;
}
