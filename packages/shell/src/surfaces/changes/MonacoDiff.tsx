// Lazy-loaded Monaco editor for the editor pane: the diff against main, or the file on its own.
// Loaded via React.lazy so the editor bundle only downloads when a file is first opened.
// Working-tree files are editable and autosave; a commit's are read-only.

import type { Theme } from "@toyon/shared";
import { toyonDark } from "@toyon/shared";
import * as monaco from "monaco-editor";
// monaco 0.56 exports map: "./*.js" -> "./esm/vs/*.js"
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { useEffect, useRef } from "react";
import type { EditorView } from "../../state/store.ts";
import { toMonacoTheme } from "./monacoTheme.ts";

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
    fontFamily: s.getPropertyValue("--face-mono").trim() || "ui-monospace, monospace",
    fontSize: Number.parseFloat(s.getPropertyValue("--size-mono-sm")) || 11,
  };
}

const THEME = "toyon";
monaco.editor.defineTheme(THEME, toMonacoTheme(toyonDark));

/** what the editor held when a view switch tore it down, so the other view opens on the same text
 * at the same place */
interface Carry {
  path: string;
  after: string;
  readOnly: boolean;
  view: EditorView;
  value: string;
  position: monaco.Position | null;
  top: number;
}

export default function MonacoDiff({
  before,
  after,
  path,
  line: focusLine,
  view,
  theme,
  readOnly = false,
  onSave,
  onLineHover,
}: {
  before: string;
  after: string;
  path: string;
  /** 1-based line to reveal + place the cursor on (search hit); otherwise the first change */
  line?: number;
  /** the diff against main, or the file with no diff drawn over it */
  view: EditorView;
  theme: Theme;
  /** a commit's diff: the modified side is history, not a file to edit */
  readOnly?: boolean;
  onSave: (path: string, content: string) => void;
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
  // A view switch rebuilds the editor from props, and the props are the file as it was opened. The
  // text has to come from the editor being torn down instead: from the props, edits autosaved since
  // would show as undone, and the next keystroke would save over them.
  const carry = useRef<Carry | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const c = carry.current;
    carry.current = null;
    // only a view switch carries: a new line to reveal or a fresh read of the file starts over
    const kept = c && c.path === path && c.after === after && c.readOnly === readOnly && c.view !== view ? c : null;
    const text = kept?.value ?? after;
    const modified = monaco.editor.createModel(text, undefined, monaco.Uri.file(`/after/${path}`));
    const unchanged = before === text;
    const base = {
      readOnly,
      automaticLayout: true,
      theme: THEME,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      ...shellType(),
      lineHeight: 1.5,
      // monaco stacks a glyph margin (a full line-height wide), a folding column and the diff
      // gutter menu (a flat 35px) ahead of the line numbers, which in a pane this short left the
      // gutter wider than the indent of the code it labels. None of the three has a job here:
      // nothing sets breakpoints, folding a diff hides the thing you opened, and reverting a hunk
      // is what the changes list's menu is for. The decorations strip stays: it carries the +/-.
      glyphMargin: false,
      folding: false,
      // rainbow brackets are Dark+ gold/orchid/blue and a theme cannot name them without
      // shipping six more colours; with them off a bracket is punctuation, which is what the
      // chat log's own diffs already draw, so a file reads the same on both surfaces
      bracketPairColorization: { enabled: false },
    };

    let original: monaco.editor.ITextModel | null = null;
    let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
    let code: monaco.editor.IStandaloneCodeEditor;
    if (view === "file") {
      code = monaco.editor.create(el, { ...base, model: modified });
    } else {
      original = monaco.editor.createModel(before, undefined, monaco.Uri.file(`/before/${path}`));
      // a carried place may sit inside an unchanged region, and collapsing would hide it. A line to
      // reveal never reaches this view: the store drops it when the view switches to the diff.
      const keepAll = unchanged || kept != null;
      diffEditor = monaco.editor.createDiffEditor(el, {
        ...base,
        originalEditable: false,
        renderSideBySide: false,
        renderOverviewRuler: false,
        renderGutterMenu: false,
        renderMarginRevertIcon: false,
        // collapsing an entirely-unchanged file hides everything — plain view instead
        hideUnchangedRegions: { enabled: !keepAll },
      });
      diffEditor.setModel({ original, modified });
      code = diffEditor.getModifiedEditor();
    }

    let reveal = () => {
      el.style.opacity = "1";
      reveal = () => {};
    };
    // diff computation is async: the editor first paints unfolded, then collapses, and the deleted
    // lines arrive as zones that push the modified ones down. Stay invisible until the first diff
    // pass so it appears already settled, then place the viewport against the final layout.
    let safety: ReturnType<typeof setTimeout> | undefined;
    const settle = (place: () => void) => {
      if (!diffEditor || unchanged) {
        place();
        reveal();
        return;
      }
      el.style.opacity = "0";
      const sub = diffEditor.onDidUpdateDiff(() => {
        sub.dispose();
        place();
        reveal();
      });
      // never stay hidden if the diff event doesn't fire. The container outlives this editor, so a
      // teardown cancels it: left running, it would show the next editor before its own diff settled.
      safety = setTimeout(() => reveal(), 400);
    };
    if (kept) {
      if (kept.position) code.setPosition(kept.position);
      settle(() => code.setScrollTop(code.getTopForLineNumber(kept.top)));
    } else if (focusLine != null) {
      const ln = Math.max(1, Math.min(focusLine, modified.getLineCount()));
      code.setPosition({ lineNumber: ln, column: 1 });
      code.revealLineInCenter(ln);
      code.focus();
      reveal();
    } else if (diffEditor && !unchanged) {
      const d = diffEditor;
      settle(() => {
        const first = d.getLineChanges()?.[0];
        code.revealLineInCenter(first?.modifiedStartLineNumber || first?.modifiedEndLineNumber || 1);
      });
    } else {
      reveal();
    }

    // IDE-style autosave: debounce after last keystroke; cmd+s still forces it. A commit's diff is
    // history, so neither is wired up: there is no working file for a write to land in.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const sub2 = readOnly
      ? null
      : modified.onDidChangeContent(() => {
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            saveTimer = null;
            saveRef.current(path, modified.getValue());
          }, 800);
        });
    if (!readOnly) {
      code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        saveRef.current(path, modified.getValue());
      });
    }

    // line hover -> highlight what that line renders on the page
    let lastLine: number | null = null;
    const subMove = code.onMouseMove((e) => {
      const line = e.target?.position?.lineNumber ?? null;
      if (line !== lastLine) {
        lastLine = line;
        hoverRef.current?.(line);
      }
    });
    const subLeave = code.onMouseLeave(() => {
      lastLine = null;
      hoverRef.current?.(null);
    });
    return () => {
      clearTimeout(safety);
      sub2?.dispose();
      subMove.dispose();
      subLeave.dispose();
      // a keystroke inside the debounce is still owed to disk when the pane closes or the view
      // switches; the path is this editor's, since the props may already name the next file
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveRef.current(path, modified.getValue());
      }
      hoverRef.current?.(null);
      carry.current = {
        path,
        after,
        readOnly,
        view,
        value: modified.getValue(),
        position: code.getPosition(),
        top: code.getVisibleRanges()[0]?.startLineNumber ?? 1,
      };
      (diffEditor ?? code).dispose();
      original?.dispose();
      modified.dispose();
    };
  }, [before, after, path, focusLine, readOnly, view]);

  return <div ref={ref} style={{ position: "absolute", inset: "33px 0 0 0" }} />;
}
