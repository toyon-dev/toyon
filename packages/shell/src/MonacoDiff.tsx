// Lazy-loaded Monaco diff viewer (read-only). Loaded via React.lazy so the
// editor bundle only downloads when a diff is first opened.

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import type { Theme } from "@orchardist/shared";
import { gruvboxDarkSoft, hex8, scaleAlpha } from "@orchardist/shared";
// monaco 0.56 exports map: "./*.js" -> "./esm/vs/*.js"
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
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

/** Monaco theme derived from the shell's Theme so the diff pane never drifts from the chrome */
function toMonacoTheme(t: Theme): monaco.editor.IStandaloneThemeData {
  const c = t.colors;
  const rules: monaco.editor.ITokenThemeRule[] = [
    { token: "", foreground: c.fg1.slice(1), background: c.bg0.slice(1) },
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
      "editor.background": c.bg0,
      "editor.foreground": c.fg1,
      "editor.lineHighlightBackground": hex8(c.bg1, 0),
      "editorLineNumber.foreground": c.bg3,
      "diffEditor.insertedTextBackground": scaleAlpha(c.addBg, 1.6),
      "diffEditor.removedTextBackground": scaleAlpha(c.delBg, 1.6),
      "diffEditor.insertedLineBackground": c.addBg,
      "diffEditor.removedLineBackground": c.delBg,
      "editorWidget.background": c.bg1,
      "scrollbarSlider.background": hex8(c.bg2, 0.4),
    },
  };
}

const THEME = "orchardist";
monaco.editor.defineTheme(THEME, toMonacoTheme(gruvboxDarkSoft));

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
      fontSize: 12,
      renderOverviewRuler: false,
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
