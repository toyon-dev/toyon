// Lazy-loaded Monaco diff viewer (read-only). Loaded via React.lazy so the
// editor bundle only downloads when a diff is first opened.

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
// monaco 0.56 exports map: "./*.js" -> "./esm/vs/*.js"
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

monaco.editor.defineTheme("gruvbox-soft", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "ebdbb2", background: "32302f" },
    { token: "comment", foreground: "928374", fontStyle: "italic" },
    { token: "keyword", foreground: "fb4934" },
    { token: "string", foreground: "b8bb26" },
    { token: "number", foreground: "d3869b" },
    { token: "type", foreground: "fabd2f" },
    { token: "function", foreground: "8ec07c" },
    { token: "variable", foreground: "83a598" },
  ],
  colors: {
    "editor.background": "#32302f",
    "editor.foreground": "#ebdbb2",
    "editor.lineHighlightBackground": "#3c383600",
    "editorLineNumber.foreground": "#665c54",
    "diffEditor.insertedTextBackground": "#b8bb2622",
    "diffEditor.removedTextBackground": "#fb493422",
    "diffEditor.insertedLineBackground": "#b8bb2615",
    "diffEditor.removedLineBackground": "#fb493415",
    "editorWidget.background": "#3c3836",
    "scrollbarSlider.background": "#50494566",
  },
});

export default function MonacoDiff({ before, after, path, onSave, onLineHover }: {
  before: string;
  after: string;
  path: string;
  onSave: (content: string) => void;
  onLineHover?: (line: number | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
    const editor = monaco.editor.createDiffEditor(el, {
      readOnly: false,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: false,
      theme: "gruvbox-soft",
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      fontSize: 12,
      renderOverviewRuler: false,
      // collapsing an entirely-unchanged file hides everything — plain view instead
      hideUnchangedRegions: { enabled: !unchanged },
    });
    editor.setModel({ original, modified });
    // diff computation is async: the editor first paints unfolded, then collapses.
    // stay invisible until the first diff pass so it appears already settled.
    let reveal = () => {
      el.style.opacity = "1";
      reveal = () => {};
    };
    if (unchanged) {
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
  }, [before, after, path]);

  return <div ref={ref} style={{ position: "absolute", inset: "33px 0 0 0" }} />;
}
