// Lazy-loaded Monaco diff viewer (read-only). Loaded via React.lazy so the
// editor bundle only downloads when a diff is first opened.

import type { Theme } from "@toyon/shared";
import { accentKey, hex8, toyonDark, wordTint } from "@toyon/shared";
import * as monaco from "monaco-editor";
// monaco 0.56 exports map: "./*.js" -> "./esm/vs/*.js"
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { useEffect, useRef } from "react";

// monaco 0.56 moved the TS language API off `monaco.languages.typescript` (now a deprecated stub)
// to a top-level `typescript` export
const { JsxEmit, ModuleKind, ModuleResolutionKind, ScriptTarget, javascriptDefaults, typescriptDefaults } =
  monaco.typescript;

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  // ts/tsx models route language requests (inlay hints, hover) to the TS worker;
  // everything else gets the base editor worker
  getWorker: (_id: string, label: string) =>
    label === "typescript" || label === "javascript" ? new tsWorker() : new editorWorker(),
};

// The TS worker has no node_modules to resolve against, so semantic checks would flag every
// import and (with default options) every JSX tag. Keep syntax errors, drop the rest; hover and
// completions still work off the file's own contents.
for (const d of [typescriptDefaults, javascriptDefaults]) {
  d.setCompilerOptions({
    jsx: JsxEmit.ReactJSX,
    target: ScriptTarget.ESNext,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.NodeJs,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
  });
  d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false, noSuggestionDiagnostics: true });
}

/** The shell's own mono ramp, read off the root element rather than restated here, so the editor
 * is the same face at the same size as the inline diffs in the chat log. Monaco otherwise picks
 * its own stack (Menlo on mac), which reads as a second app inside the pane. */
function shellType() {
  const s = getComputedStyle(document.documentElement);
  return {
    fontFamily: s.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace",
    fontSize: Number.parseFloat(s.getPropertyValue("--fs-xs")) || 11,
  };
}

/** Monaco theme derived from the shell's Theme so the diff pane never drifts from the chrome */
function toMonacoTheme(t: Theme): monaco.editor.IStandaloneThemeData {
  const c = t.colors;
  const rules: monaco.editor.ITokenThemeRule[] = [
    { token: "", foreground: c.text0.slice(1), background: c.surface0.slice(1) },
  ];
  for (const [token, color] of Object.entries(t.syntax ?? {})) {
    if (color)
      rules.push({ token, foreground: color.slice(1), ...(token === "comment" ? { fontStyle: "italic" } : {}) });
  }
  return {
    base: t.kind === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules,
    colors: {
      "editor.background": c.surface0,
      "editor.foreground": c.text0,
      "editor.lineHighlightBackground": hex8(c.surface1, 0),
      "editorLineNumber.foreground": c.border1,
      "editorLineNumber.activeForeground": c.text1,
      "editorGutter.background": c.surface0,
      "editorCursor.foreground": c[accentKey(t)],
      // monaco paints .line-insert and .char-insert as separate elements, and on a wholly new line
      // the word-level range covers the whole line, so the two tints composite. wordTint is the
      // fraction that keeps that composite where the chat log's own word blocks sit, and both read
      // it from the same place, so the pane and the log cannot drift apart.
      "diffEditor.insertedTextBackground": wordTint(c.diffAdd),
      "diffEditor.removedTextBackground": wordTint(c.diffDel),
      "diffEditor.insertedLineBackground": c.diffAdd,
      "diffEditor.removedLineBackground": c.diffDel,
      // the "N hidden lines" band sits over the code it hides, so it has to be opaque
      "diffEditor.unchangedRegionBackground": c.surface1,
      "diffEditor.unchangedRegionForeground": c.text2,
      "diffEditor.unchangedCodeBackground": hex8(c.surface0, 0),
      "editorWidget.background": c.surface1,
      "scrollbarSlider.background": hex8(c.surface2, 0.4),
    },
  };
}

const THEME = "toyon";
monaco.editor.defineTheme(THEME, toMonacoTheme(toyonDark));

export default function MonacoDiff({
  before,
  after,
  path,
  line: focusLine,
  theme,
  onSave,
  onLineHover,
}: {
  before: string;
  after: string;
  path: string;
  /** 1-based line to reveal + place the cursor on (search hit); otherwise the first change */
  line?: number;
  theme: Theme;
  onSave: (content: string) => void;
  onLineHover?: (line: number | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // setTheme is global: every editor follows, including ones created before the change
  useEffect(() => {
    monaco.editor.defineTheme(THEME, toMonacoTheme(theme));
    monaco.editor.setTheme(THEME);
  }, [theme]);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const hoverRef = useRef(onLineHover);
  hoverRef.current = onLineHover;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const original = monaco.editor.createModel(before, undefined, monaco.Uri.file(`/before/${path}`));
    const modified = monaco.editor.createModel(after, undefined, monaco.Uri.file(`/after/${path}`));
    const unchanged = before === after;
    // a targeted line may sit inside an unchanged region — don't collapse those, or it'd be hidden
    const keepAll = unchanged || focusLine != null;
    const editor = monaco.editor.createDiffEditor(el, {
      readOnly: false,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: false,
      theme: THEME,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      ...shellType(),
      lineHeight: 1.5,
      renderOverviewRuler: false,
      // monaco stacks a glyph margin (a full line-height wide), a folding column and the diff
      // gutter menu (a flat 35px) ahead of the line numbers, which in a pane this short left the
      // gutter wider than the indent of the code it labels. None of the three has a job here:
      // nothing sets breakpoints, folding a diff hides the thing you opened, and reverting a hunk
      // is what the changes list's menu is for. The decorations strip stays: it carries the +/-.
      glyphMargin: false,
      folding: false,
      renderGutterMenu: false,
      renderMarginRevertIcon: false,
      // collapsing an entirely-unchanged file hides everything — plain view instead
      hideUnchangedRegions: { enabled: !keepAll },
    });
    editor.setModel({ original, modified });
    // diff computation is async: the editor first paints unfolded, then collapses.
    // stay invisible until the first diff pass so it appears already settled.
    let reveal = () => {
      el.style.opacity = "1";
      reveal = () => {};
    };
    if (focusLine != null) {
      const me0 = editor.getModifiedEditor();
      const ln = Math.max(1, Math.min(focusLine, modified.getLineCount()));
      me0.setPosition({ lineNumber: ln, column: 1 });
      me0.revealLineInCenter(ln);
      me0.focus();
      reveal();
    } else if (unchanged) {
      editor.getModifiedEditor().setScrollTop(0);
      reveal();
    } else {
      el.style.opacity = "0";
      const sub = editor.onDidUpdateDiff(() => {
        sub.dispose();
        const first = editor.getLineChanges()?.[0];
        const line = first?.modifiedStartLineNumber || first?.modifiedEndLineNumber || 1;
        editor.getModifiedEditor().revealLineInCenter(line);
        reveal();
      });
      // safety: never stay hidden if the diff event doesn't fire
      setTimeout(() => reveal(), 400);
    }
    // IDE-style autosave: debounce after last keystroke; cmd+s still forces it
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const sub2 = modified.onDidChangeContent(() => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveRef.current(modified.getValue()), 800);
    });
    editor.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveRef.current(modified.getValue());
    });

    // line hover -> highlight what that line renders on the page
    let lastLine: number | null = null;
    const me = editor.getModifiedEditor();
    const subMove = me.onMouseMove((e) => {
      const line = e.target?.position?.lineNumber ?? null;
      if (line !== lastLine) {
        lastLine = line;
        hoverRef.current?.(line);
      }
    });
    const subLeave = me.onMouseLeave(() => {
      lastLine = null;
      hoverRef.current?.(null);
    });
    return () => {
      sub2.dispose();
      subMove.dispose();
      subLeave.dispose();
      if (saveTimer) clearTimeout(saveTimer);
      hoverRef.current?.(null);
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [before, after, path, focusLine]);

  return <div ref={ref} style={{ position: "absolute", inset: "33px 0 0 0" }} />;
}
