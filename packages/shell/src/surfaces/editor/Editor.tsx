// Lazy-loaded Monaco editor for the editor pane: the open file as its diff against main, or on its own.
// Loaded via React.lazy so the editor bundle only downloads when a file is first opened.
//
// The file's text lives in one model for as long as the pane has the file open. A view switch puts
// a different editor over that model and a change on disk arrives as an edit to it, so undo, the
// caret and anything unsaved survive both. When to save, and whether to take what changed on disk,
// is fileSync's; this component holds the text and reports edits.

import type { Theme } from "@toyon/shared";
import { toyonDark } from "@toyon/shared";
import * as monaco from "monaco-editor";
// monaco 0.56 exports map: "./*.js" -> "./esm/vs/*.js"
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { useEffect, useRef } from "react";
import { selectedLines } from "../../app/copiedSource.ts";
import type { EditorSync, SyncBuffer } from "../../state/fileSync.ts";
import type { EditorDisk, EditorView, FileRef } from "../../state/store.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { minimalEdit } from "./minimalEdit.ts";
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

// ⌘E and ⌘I arm the element picker wherever the keyboard is, so Monaco's own bindings for them come
// off: find-with-selection on ⌘E, and suggest's second key on ⌘I (⌃Space still suggests). A key
// Monaco does not bind is not stopped at its input, so the keydown reaches useChords on the window.
monaco.editor.addKeybindingRules(
  (
    [
      ["actions.findWithSelection", monaco.KeyCode.KeyE],
      ["editor.action.triggerSuggest", monaco.KeyCode.KeyI],
      ["focusSuggestion", monaco.KeyCode.KeyI],
      ["toggleSuggestionDetails", monaco.KeyCode.KeyI],
    ] as const
  ).map(([command, key]) => ({ keybinding: monaco.KeyMod.CtrlCmd | key, command: `-${command}` })),
);

function editorOptions(readOnly: boolean) {
  return {
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
}

/** the editor put over the models for one view */
interface Instance {
  code: monaco.editor.IStandaloneCodeEditor;
  dispose(): void;
}

export default function Editor({
  file,
  disk,
  view,
  openSeq,
  line,
  focus,
  readOnly,
  theme,
  sync,
  onLineHover,
  onCopy,
  onChat,
}: {
  file: FileRef;
  /** the file as last read: the text is taken from it once, the diff's other side follows it */
  disk: EditorDisk;
  view: EditorView;
  /** which open this is: a line to reveal and the keyboard are each handed over once per open */
  openSeq: number;
  /** 1-based line to reveal and put the caret on, once it is known */
  line?: number;
  /** the keyboard follows the file in */
  focus: boolean;
  readOnly: boolean;
  theme: Theme;
  sync: EditorSync;
  onLineHover?: (line: number | null) => void;
  /** a copy out of the editor, in either view: the lines it took, and the clipboard to say so on */
  onCopy?: (path: string, lines: { startLine: number; endLine: number }, clipboard: DataTransfer) => void;
  /** ⌘L: the selection it took, or null when there was none and only the keyboard moves */
  onChat?: (path: string, taken: { startLine: number; endLine: number; text: string } | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // setTheme is global: every editor follows, including ones created before the change
  useEffect(() => {
    monaco.editor.defineTheme(THEME, toMonacoTheme(theme));
    monaco.editor.setTheme(THEME);
  }, [theme]);
  const hoverRef = useRef(onLineHover);
  hoverRef.current = onLineHover;
  const copyRef = useRef(onCopy);
  copyRef.current = onCopy;
  const chatRef = useRef(onChat);
  chatRef.current = onChat;
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const lineRef = useRef(line);
  lineRef.current = line;
  const models = useRef<{ modified: monaco.editor.ITextModel; original: monaco.editor.ITextModel } | null>(null);
  const instance = useRef<Instance | null>(null);
  /** where the last editor over this file left off, for the next view to pick up */
  const place = useRef<monaco.editor.ICodeEditorViewState | null>(null);
  const revealedFor = useRef<number | null>(null);
  const focusedFor = useRef<number | null>(null);

  // The models, for as long as this file is open: the pane keys this component by file, so another
  // file is another mount. `sync` is taken once here, so an edit still owed to disk on the way out
  // goes to this file whatever the props say by then.
  useOnChange([file.worktreeId, file.path, file.ref], () => {
    const el = ref.current;
    if (!el) return;
    const s = sync;
    const scope = `/${file.worktreeId}/${file.ref ?? "work"}`;
    const modified = monaco.editor.createModel(disk.after, undefined, monaco.Uri.file(`${scope}/after/${file.path}`));
    const original = monaco.editor.createModel(disk.before, undefined, monaco.Uri.file(`${scope}/before/${file.path}`));
    models.current = { modified, original };
    let applying = false;
    const buffer: SyncBuffer = {
      text: () => modified.getValue(),
      normalize: (text) => text.replace(/\r\n|\r|\n/g, modified.getEOL()),
      replace(text) {
        const edit = minimalEdit(modified.getValue(), buffer.normalize(text));
        if (!edit) return;
        const range = monaco.Range.fromPositions(modified.getPositionAt(edit.start), modified.getPositionAt(edit.end));
        applying = true;
        try {
          // an undo stop either side, so one undo brings back what the editor held before
          modified.pushStackElement();
          modified.pushEditOperations([], [{ range, text: edit.text }], () => null);
          modified.pushStackElement();
        } finally {
          applying = false;
        }
      },
    };
    const edits = modified.onDidChangeContent(() => {
      if (!applying) s.edited();
    });
    // Where the keyboard came from, so closing the pane from inside the editor can hand it back. It
    // is tracked as it moves rather than read at teardown: this cleanup runs after React has taken
    // the editor out of the page, and by then the browser has already dropped the focus to the body.
    let cameFrom: HTMLElement | null = null;
    let holding = false;
    const onFocusIn = (e: FocusEvent) => {
      holding = true;
      if (e.relatedTarget instanceof HTMLElement && !el.contains(e.relatedTarget)) cameFrom = e.relatedTarget;
    };
    // only a move to somewhere else lets go; a window losing focus, or the editor leaving the page, does not
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget instanceof Node && !el.contains(e.relatedTarget)) holding = false;
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    s.attach(buffer);
    return () => {
      // let go of the buffer first: an edit not yet saved is read out of the model on the way
      s.attach(null);
      edits.dispose();
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      instance.current?.dispose();
      instance.current = null;
      models.current = null;
      modified.dispose();
      original.dispose();
      // and only into a page where nothing else has taken the keyboard since
      const dropped = document.activeElement === null || document.activeElement === document.body;
      if (holding && dropped && cameFrom?.isConnected) cameFrom.focus();
    };
  });

  // the diff's other side is history nobody edits, so a fresh read simply replaces it
  useOnChange([disk.before], () => {
    const m = models.current;
    if (m && m.original.getValue() !== disk.before) m.original.setValue(disk.before);
  });

  // one editor per view, over the same models
  useOnChange([view], () => {
    const el = ref.current;
    const m = models.current;
    if (!el || !m) return;
    const restored = place.current;
    const unchanged = m.original.getValue() === m.modified.getValue();
    const options = editorOptions(readOnlyRef.current);
    let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
    let code: monaco.editor.IStandaloneCodeEditor;
    if (view === "file") {
      code = monaco.editor.create(el, { ...options, model: m.modified });
    } else {
      diffEditor = monaco.editor.createDiffEditor(el, {
        ...options,
        originalEditable: false,
        renderSideBySide: false,
        renderOverviewRuler: false,
        renderGutterMenu: false,
        renderMarginRevertIcon: false,
        // a place carried over from the other view, or a line to reveal, may sit in an unchanged
        // region that collapsing would hide; and an unchanged file collapses to nothing at all
        hideUnchangedRegions: { enabled: !unchanged && !restored && lineRef.current === undefined },
      });
      diffEditor.setModel({ original: m.original, modified: m.modified });
      code = diffEditor.getModifiedEditor();
    }

    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      el.style.opacity = "1";
    };
    let safety: ReturnType<typeof setTimeout> | undefined;
    // the diff is computed off the main thread: the editor first paints unfolded, then collapses, and
    // deleted lines arrive as zones that push the file's own lines down. Stay invisible until the
    // first pass so it appears settled, then place the viewport against the final layout.
    const settle = (placeIt: () => void) => {
      const d = diffEditor;
      if (!d || unchanged) {
        placeIt();
        show();
        return;
      }
      el.style.opacity = "0";
      const sub = d.onDidUpdateDiff(() => {
        sub.dispose();
        placeIt();
        show();
      });
      // never stay hidden if the diff event does not fire
      safety = setTimeout(show, 400);
    };
    const d = diffEditor;
    if (restored) settle(() => code.restoreViewState(restored));
    else if (d && !unchanged && lineRef.current === undefined) {
      settle(() => {
        const first = d.getLineChanges()?.[0];
        code.revealLineInCenter(first?.modifiedStartLineNumber || first?.modifiedEndLineNumber || 1);
      });
    } else show();

    // ⌘S saves now rather than once typing rests
    code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => syncRef.current.saveNow());

    // line hover -> highlight what that line renders on the page
    let lastLine: number | null = null;
    const subMove = code.onMouseMove((e) => {
      const hovered = e.target?.position?.lineNumber ?? null;
      if (hovered !== lastLine) {
        lastLine = hovered;
        hoverRef.current?.(hovered);
      }
    });
    const subLeave = code.onMouseLeave(() => {
      lastLine = null;
      hoverRef.current?.(null);
    });

    // Both views copy out of `code`: the file view is that editor, and the diff view's deleted lines
    // are zones in it that a selection cannot take, so the lines a copy names are the file's own.
    // Capture phase: monaco may stop the event at its own input, and it only ever adds flavours, so
    // one set ahead of it survives.
    const tagCopy = (e: ClipboardEvent) => {
      const [sel, ...more] = code.getSelections() ?? [];
      // several cursors copy lines that no single range names
      if (!e.clipboardData || !sel || more.length > 0 || !code.hasTextFocus()) return;
      copyRef.current?.(file.path, selectedLines(sel), e.clipboardData);
    };
    el.addEventListener("copy", tagCopy, true);
    el.addEventListener("cut", tagCopy, true);

    // ⌘L gives the chat what is selected, named for the lines it covers, and with nothing selected
    // only moves the keyboard to the box, as ⌘L does everywhere else. Monaco binds the key to
    // expanding the line selection and keeps it from the window, so the editor answers it itself:
    // two actions split on whether there is a selection, and the one that takes it sits in the
    // context menu, which shows the key beside it to anyone who has not read the shortcuts.
    const chatKey = [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL];
    const chatAction = code.addAction({
      id: "toyon.add-to-chat",
      label: "Add to Chat",
      keybindings: chatKey,
      precondition: "editorHasSelection",
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 5,
      run: () => {
        const [sel, ...more] = code.getSelections() ?? [];
        // several cursors take lines that no single range names; the keyboard still moves
        const taken =
          sel && more.length === 0 ? { ...selectedLines(sel), text: m.modified.getValueInRange(sel) } : null;
        chatRef.current?.(file.path, taken);
      },
    });
    const focusAction = code.addAction({
      id: "toyon.focus-chat",
      label: "Focus Chat",
      keybindings: chatKey,
      precondition: "!editorHasSelection",
      run: () => chatRef.current?.(file.path, null),
    });

    const mine: Instance = {
      code,
      dispose: () => {
        clearTimeout(safety);
        subMove.dispose();
        subLeave.dispose();
        chatAction.dispose();
        focusAction.dispose();
        el.removeEventListener("copy", tagCopy, true);
        el.removeEventListener("cut", tagCopy, true);
        hoverRef.current?.(null);
        // neither editor owns the models (they were handed in), so this leaves the text alone
        (diffEditor ?? code).dispose();
      },
    };
    instance.current = mine;
    return () => {
      // the models' own teardown may have got here first
      if (instance.current !== mine) return;
      place.current = code.saveViewState();
      mine.dispose();
      instance.current = null;
    };
  });

  useOnChange([readOnly], () => {
    instance.current?.code.updateOptions({ readOnly });
  });

  // a jump is made once per open: the same line on a later render is not another request to go there
  useOnChange([openSeq, line], () => {
    const code = instance.current?.code;
    const model = models.current?.modified;
    if (!code || !model || line === undefined || revealedFor.current === openSeq) return;
    revealedFor.current = openSeq;
    const ln = Math.max(1, Math.min(line, model.getLineCount()));
    code.setPosition({ lineNumber: ln, column: 1 });
    code.revealLineInCenter(ln);
  });

  // the keyboard follows a file opened on purpose, once per open; one walked to in a list stays there
  useOnChange([openSeq], () => {
    if (!focus || focusedFor.current === openSeq) return;
    focusedFor.current = openSeq;
    instance.current?.code.focus();
  });

  return <div ref={ref} className="editor-monaco" />;
}
