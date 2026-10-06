// Lazy-loaded Monaco editor for the editor pane: the open file as its diff against main, or on its own.
// Loaded via React.lazy so the editor bundle only downloads when a file is first opened.
//
// The file's text lives in one model for as long as the pane has the file open. A view switch puts
// a different editor over that model and a change on disk arrives as an edit to it, so undo, the
// caret and anything unsaved survive both. When to save, and whether to take what changed on disk,
// is fileSync's; this component holds the text and reports edits.

import type { BlameCommit, Theme } from "@toyon/shared";
import { toyonDark } from "@toyon/shared";
import * as monaco from "monaco-editor";
// monaco 0.56 exports map: "./*.js" -> "./esm/vs/*.js"
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { useEffect, useRef, useState } from "react";
import { selectedLines } from "../../app/copiedSource.ts";
import type { EditorSync, SyncBuffer } from "../../state/fileSync.ts";
import type { EditorBlame, EditorDisk, EditorView, FileRef } from "../../state/store.ts";
import { Float } from "../../ui/Float.tsx";
import { passPinch, useOnChange } from "../../ui/hooks.ts";
import type { Placement, Rect } from "../../ui/place.ts";
import { blameCommit, blameLine } from "./blameLine.ts";
import { diffFit, FOLD_MIN, type Hunk, type Pane } from "./diffFit.ts";
import { registerGrammars } from "./grammar.ts";
import { minimalEdit } from "./minimalEdit.ts";
import { toMonacoTheme } from "./monacoTheme.ts";
import { languageFor, registerTsx } from "./tsx.ts";

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

// the tsx language first: a tokens provider can only be set for a language Monaco already knows
registerTsx();
registerGrammars(monaco);

const THEME = "toyon";
monaco.editor.defineTheme(THEME, toMonacoTheme(toyonDark));

// The shell's chords that Monaco would otherwise keep for itself come off, so a hand in the editor
// gets the same key as everywhere else: ⌘E and ⌘I arm the element picker (find-with-selection and
// suggest's second key; ⌃Space still suggests), F1 opens the palette, ⌥↑/↓ and ⌥⇧↑/↓ walk the
// worktrees (move-line and copy-line), ⌘U lists the routes (cursor undo). A key Monaco does not
// bind is not stopped at its input, so the keydown reaches useChords on the window. ⌘K cannot come
// off this way: it is the prefix of two dozen chords, so the editor answers it itself (below).
const cmd = monaco.KeyMod.CtrlCmd;
const alt = monaco.KeyMod.Alt;
monaco.editor.addKeybindingRules(
  (
    [
      ["actions.findWithSelection", cmd | monaco.KeyCode.KeyE],
      ["editor.action.triggerSuggest", cmd | monaco.KeyCode.KeyI],
      ["focusSuggestion", cmd | monaco.KeyCode.KeyI],
      ["toggleSuggestionDetails", cmd | monaco.KeyCode.KeyI],
      ["editor.action.quickCommand", monaco.KeyCode.F1],
      ["editor.action.moveLinesUpAction", alt | monaco.KeyCode.UpArrow],
      ["editor.action.moveLinesDownAction", alt | monaco.KeyCode.DownArrow],
      ["editor.action.copyLinesUpAction", alt | monaco.KeyMod.Shift | monaco.KeyCode.UpArrow],
      ["editor.action.copyLinesDownAction", alt | monaco.KeyMod.Shift | monaco.KeyCode.DownArrow],
      ["cursorUndo", cmd | monaco.KeyCode.KeyU],
    ] as const
  ).map(([command, keybinding]) => ({ keybinding, command: `-${command}` })),
);

function editorOptions(readOnly: boolean, numbers: boolean) {
  return {
    readOnly,
    // the diff numbers both sides, two columns that take a fifth of a phone's width before any
    // code; the +/- strip still says which lines changed
    lineNumbers: numbers ? ("on" as const) : ("off" as const),
    automaticLayout: true,
    theme: THEME,
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    // a scroll the editor has no room left for goes on to the window, which pans when it is
    // pinch-zoomed; by default Monaco cancels every wheel event over it
    scrollbar: { alwaysConsumeMouseWheel: false },
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

/** the diff's strip of hunks down the right edge. It carries a viewport of its own that drags and
 * wheels like a scrollbar, so with the strip up the editor's bar beside it would be a second
 * slider for the same scroll, 14px further into the code; the bar takes no width then. */
const overviewStrip = (on: boolean) => ({
  renderOverviewRuler: on,
  scrollbar: { verticalScrollbarSize: on ? 0 : 14 },
});

/** Monaco colours the lines an editor shows on a 50ms timer after it shows them, so a model made
 * for this open would paint its first frames in plain text and then flash into colour. Tokenizing
 * those lines before the frame skips the plain paint. `tokenization` is not in monaco's types. Past
 * the cap a jump deep into a long file would tokenize everything above it on the main thread, so
 * there Monaco's own pass colours the lines, a frame or two late. */
const TOKENIZE_NOW = 3000;

/** the diff's hunks with the line count on each side. Monaco marks a side with nothing by an end
 * of 0, and then its start names the line the change sits after rather than the first of a range.
 * `inPlace` is Monaco's own test for the true inline view, which it does not export: every edit
 * inside the hunk starts and ends on one line of each side, an insert at the top of the file aside. */
const hunksOf = (d: monaco.editor.IDiffEditor): Hunk[] =>
  (d.getLineChanges() ?? []).map((c) => ({
    modifiedStart: c.modifiedEndLineNumber ? c.modifiedStartLineNumber : c.modifiedStartLineNumber + 1,
    original: c.originalEndLineNumber ? c.originalEndLineNumber - c.originalStartLineNumber + 1 : 0,
    modified: c.modifiedEndLineNumber ? c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1 : 0,
    inPlace:
      c.charChanges?.every(
        (i) =>
          (i.originalStartLineNumber === i.originalEndLineNumber &&
            i.modifiedStartLineNumber === i.modifiedEndLineNumber) ||
          (i.originalStartLineNumber === 1 &&
            i.originalStartColumn === 1 &&
            i.originalEndLineNumber === 1 &&
            i.originalEndColumn === 1),
      ) ?? false,
  }));

/** the room the fit has: the height Monaco laid the editor out at, less the horizontal scrollbar.
 * Monaco's height and not the box's: the box reports a fractional height rounded, Monaco floors
 * it, and a fold sized to the rounded one scrolled by that pixel. Monaco adds the bar's height to
 * the content whenever a line runs wider than the box, so the last line can be read above it, and
 * a fold sized without it scrolled by exactly that much. Reserved always rather than measured: the
 * width Monaco knows is that of the lines it has drawn, so a wide line further down would add the
 * bar after the fit was made. The reserve costs one context line at most. */
const paneOf = (code: monaco.editor.ICodeEditor): Pane => {
  const scrollbar = code.getOption(monaco.editor.EditorOption.scrollbar);
  const bar = scrollbar.horizontal === monaco.editor.ScrollbarVisibility.Hidden ? 0 : scrollbar.horizontalScrollbarSize;
  return {
    height: code.getLayoutInfo().height - bar,
    lineHeight: code.getOption(monaco.editor.EditorOption.lineHeight),
  };
};
function tokenizeThrough(model: monaco.editor.ITextModel, line: number) {
  const through = Math.min(line, model.getLineCount());
  if (through < 1 || through > TOKENIZE_NOW) return;
  (model as unknown as { tokenization: { forceTokenization(line: number): void } }).tokenization.forceTokenization(
    through,
  );
}

/** the commit the blame note names, shown over the note while the pointer rests on it */
interface BlameCard {
  commit: BlameCommit;
  /** the note's box, which the card hangs under */
  anchor: Rect;
}
/** Monaco's own hover rest, not the tooltip's shorter one: the note sits in the text a pointer
 * crosses on its way anywhere, and a card on every crossing would flicker over the code */
const CARD_DELAY = 300;
const CARD_PLACEMENT: Placement = { side: "bottom", align: "start", offset: 6, flip: "side", margin: 8 };
const CARD_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** the box all the note's spans cover: Monaco cuts a long injected text into several */
function noteRect(root: HTMLElement): Rect | null {
  let rect: Rect | null = null;
  for (const span of root.querySelectorAll(".editor-blame")) {
    const b = span.getBoundingClientRect();
    rect = rect
      ? {
          left: Math.min(rect.left, b.left),
          top: Math.min(rect.top, b.top),
          right: Math.max(rect.right, b.right),
          bottom: Math.max(rect.bottom, b.bottom),
        }
      : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  }
  return rect;
}

/** the editor put over the models for one view */
interface Instance {
  code: monaco.editor.IStandaloneCodeEditor;
  /** draw the blame after the caret's line, or take it away, from what is known now */
  paint(): void;
  dispose(): void;
}

/** One open of this file: its text, and what has already been handed to whichever editor shows it.
 * Everything that describes the open lives here rather than in a ref of its own, so it is made and
 * thrown away with the open. StrictMode's rehearsal ends the open and starts it again on the same
 * component, and the new one starts clean with nothing left over to reset. */
interface Session {
  modified: monaco.editor.ITextModel;
  original: monaco.editor.ITextModel;
  /** where the last editor over this file left off, for the next view to pick up */
  place: monaco.editor.ICodeEditorViewState | null;
  /** the open whose line has been revealed: the same line on a later render is not another request */
  revealedFor: number | null;
  /** the open that has been given the keyboard */
  focusedFor: number | null;
  /** the file as the daemon last read it, in the model's line endings: the blame names its lines */
  diskText: string;
  /** the text is not that read, line for line: a keystroke moves the lines under it, so the blame
   * stays away until the text is that read again (an undo) or saved and read anew */
  dirty: boolean;
}

/** whether the model's text is not `text`: the lengths first, since a keystroke changes them, and
 * the whole text only when they agree */
function differs(model: monaco.editor.ITextModel, text: string): boolean {
  return model.getValueLength() !== text.length || model.getValue() !== text;
}

export default function Editor({
  file,
  disk,
  blame,
  view,
  openSeq,
  line,
  focus,
  readOnly,
  numbers,
  theme,
  sync,
  onLineHover,
  onCopy,
  onChat,
  onNew,
}: {
  file: FileRef;
  /** the file as last read: the text is taken from it once, the diff's other side follows it */
  disk: EditorDisk;
  /** who last touched each line, for the version of the file it names; shown after the caret's line */
  blame: EditorBlame | null;
  view: EditorView;
  /** which open this is: a line to reveal and the keyboard are each handed over once per open */
  openSeq: number;
  /** 1-based line to reveal and put the caret on, once it is known */
  line?: number;
  /** the keyboard follows the file in */
  focus: boolean;
  readOnly: boolean;
  /** whether the gutter numbers its lines */
  numbers: boolean;
  theme: Theme;
  sync: EditorSync;
  onLineHover?: (line: number | null) => void;
  /** a copy out of the editor, in either view: the lines it took, and the clipboard to say so on */
  onCopy?: (path: string, lines: { startLine: number; endLine: number }, clipboard: DataTransfer) => void;
  /** ⌘L: the selection it took, or null when there was none and only the keyboard moves */
  onChat?: (path: string, taken: { startLine: number; endLine: number; text: string } | null) => void;
  /** ⌘K: a new worktree, the chord the window would answer if Monaco let the key through */
  onNew?: () => void;
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
  const newRef = useRef(onNew);
  newRef.current = onNew;
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const lineRef = useRef(line);
  lineRef.current = line;
  const blameRef = useRef(blame);
  blameRef.current = blame;
  const diskRef = useRef(disk);
  diskRef.current = disk;
  const session = useRef<Session | null>(null);
  const instance = useRef<Instance | null>(null);
  const [card, setCard] = useState<BlameCard | null>(null);

  // The session, for as long as this file is open: the pane keys this component by file, so another
  // file is another mount. `sync` is taken once here, so an edit still owed to disk on the way out
  // goes to this file whatever the props say by then.
  useOnChange([file.worktreeId, file.path, file.ref, file.since], () => {
    const el = ref.current;
    if (!el) return;
    const s = sync;
    const scope = `/${file.worktreeId}/${file.ref ?? file.since ?? "work"}`;
    const modified = monaco.editor.createModel(
      disk.after,
      languageFor(file.path),
      monaco.Uri.file(`${scope}/after/${file.path}`),
    );
    const original = monaco.editor.createModel(
      disk.before,
      languageFor(file.path),
      monaco.Uri.file(`${scope}/before/${file.path}`),
    );
    // a model reads bracket colouring when it is made, and these are made before any editor has
    // pushed its options, so the editor's `bracketPairColorization` never reaches them
    for (const m of [modified, original])
      m.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
    const sess: Session = {
      modified,
      original,
      place: null,
      revealedFor: null,
      focusedFor: null,
      diskText: modified.getValue(),
      dirty: false,
    };
    session.current = sess;
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
      sess.dirty = differs(modified, sess.diskText);
      instance.current?.paint();
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
      session.current = null;
      modified.dispose();
      original.dispose();
      // and only into a page where nothing else has taken the keyboard since
      const dropped = document.activeElement === null || document.activeElement === document.body;
      if (holding && dropped && cameFrom?.isConnected) cameFrom.focus();
    };
  });

  // the diff's other side is history nobody edits, so a fresh read simply replaces it
  useOnChange([disk.before], () => {
    const m = session.current;
    if (m && m.original.getValue() !== disk.before) m.original.setValue(disk.before);
  });

  // a fresh read: the blame that follows it names these lines, so the text is measured against it
  useOnChange([disk], () => {
    const m = session.current;
    if (!m) return;
    m.diskText = disk.after.replace(/\r\n|\r|\n/g, m.modified.getEOL());
    m.dirty = differs(m.modified, m.diskText);
    instance.current?.paint();
  });

  useOnChange([blame], () => instance.current?.paint());

  // one editor per view, over the same models
  useOnChange([view], () => {
    const el = ref.current;
    const m = session.current;
    if (!el || !m) return;
    const restored = m.place;
    const unchanged = m.original.getValue() === m.modified.getValue();
    const options = editorOptions(readOnlyRef.current, numbers);
    let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
    let code: monaco.editor.IStandaloneCodeEditor;
    if (view === "file") {
      code = monaco.editor.create(el, { ...options, model: m.modified });
    } else {
      diffEditor = monaco.editor.createDiffEditor(el, {
        ...options,
        originalEditable: false,
        renderSideBySide: false,
        // a change within one line reads on that line: added text highlighted, removed text struck
        // through in place, instead of the whole old line drawn again above the new one
        experimental: { useTrueInlineView: true },
        renderGutterMenu: false,
        renderMarginRevertIcon: false,
        // the strip has nothing to map on a file with no hunks
        ...overviewStrip(!unchanged),
        // a place carried over from the other view, or a line to reveal, may sit in an unchanged
        // region that folding would hide; and an unchanged file folds to nothing at all
        hideUnchangedRegions: {
          enabled: !unchanged && !restored && lineRef.current === undefined,
          minimumLineCount: FOLD_MIN,
        },
      });
      diffEditor.setModel({ original: m.original, modified: m.modified });
      code = diffEditor.getModifiedEditor();
    }

    // colour whatever the first shown frame holds: the viewport as created, and again each time a
    // restore, a reveal or the diff's collapse moves it before that frame
    const colour = () => {
      const last = code.getVisibleRanges().at(-1)?.endLineNumber;
      if (!last) return;
      tokenizeThrough(m.modified, last);
      // the diff's deleted lines are drawn from the other side, which runs longer by what was removed
      if (diffEditor)
        tokenizeThrough(m.original, last + Math.max(0, m.original.getLineCount() - m.modified.getLineCount()));
    };
    colour();
    const scrolled = code.onDidScrollChange(colour);
    let painted = 0;
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      colour();
      el.style.opacity = "1";
      // once a frame is up, Monaco's own pass keeps up with scrolling
      painted = requestAnimationFrame(() => scrolled.dispose());
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
        // the hunks are known now, so the pane's own height can say what is worth folding. The
        // strip beside the scrollbar maps hunks that are off the screen; with every hunk on it,
        // it is the gutter's marks drawn a second time, smaller
        const { scrolls, ...fold } = diffFit(paneOf(code), m.modified.getLineCount(), hunksOf(d));
        d.updateOptions({
          hideUnchangedRegions: { ...fold, minimumLineCount: FOLD_MIN },
          ...overviewStrip(scrolls),
        });
        const first = d.getLineChanges()?.[0];
        code.revealLineInCenter(first?.modifiedStartLineNumber || first?.modifiedEndLineNumber || 1);
      });
    } else show();

    // ⌘S saves now rather than once typing rests
    code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => syncRef.current.saveNow());
    // ⌘K is the shell's new-worktree key. Monaco holds it as the prefix of its ⌘K ⌘C family and
    // stops the keydown while it waits for the second key, so the window never sees it; a binding on
    // the bare key resolves ahead of every chord and answers it here instead.
    code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => newRef.current?.());

    // The card over the blame note, after the tooltip's own rest. The note is Monaco's span, which
    // carries no attributes of its own, so the pointer is read off the editor's mouse events rather
    // than delegated through data-tip. It leaves as the pointer does, and with the note.
    let cardTimer: ReturnType<typeof setTimeout> | undefined;
    let onNote = false;
    const dropCard = () => {
      clearTimeout(cardTimer);
      cardTimer = undefined;
      onNote = false;
      setCard(null);
    };
    // line hover -> highlight what that line renders on the page
    let lastLine: number | null = null;
    const subMove = code.onMouseMove((e) => {
      const hovered = e.target?.position?.lineNumber ?? null;
      if (hovered !== lastLine) {
        lastLine = hovered;
        hoverRef.current?.(hovered);
      }
      const over = e.target.element?.classList.contains("editor-blame") ?? false;
      if (over === onNote) return;
      if (!over) {
        dropCard();
        return;
      }
      onNote = true;
      cardTimer = setTimeout(() => {
        const b = blameRef.current;
        const pos = code.getPosition();
        const commit = b && pos ? blameCommit(b, pos.lineNumber) : null;
        const anchor = noteRect(el);
        if (commit && anchor) setCard({ commit, anchor });
      }, CARD_DELAY);
    });
    const subLeave = code.onMouseLeave(() => {
      lastLine = null;
      hoverRef.current?.(null);
      dropCard();
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
    // toggles the chat, as ⌘L does everywhere else. Monaco binds the key to
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
      id: "toyon.toggle-chat",
      label: "Toggle Chat",
      keybindings: chatKey,
      precondition: "!editorHasSelection",
      run: () => chatRef.current?.(file.path, null),
    });

    // Who last touched the caret's line, drawn after it. Only while the text is the read the blame
    // followed: a blame for another version, or text typed since, would put a name on the wrong
    // line, so then there is none. The caret walks past the ghost as if it were not there.
    const ghosts = code.createDecorationsCollection();
    const paint = () => {
      // the note the card was about is redrawn or gone either way
      dropCard();
      const b = blameRef.current;
      const pos = code.getPosition();
      const text = b && b.version === diskRef.current.version && !m.dirty && pos ? blameLine(b, pos.lineNumber) : null;
      if (!text || !pos) {
        ghosts.clear();
        return;
      }
      const col = m.modified.getLineMaxColumn(pos.lineNumber);
      ghosts.set([
        {
          range: new monaco.Range(pos.lineNumber, col, pos.lineNumber, col),
          options: {
            after: {
              content: text,
              inlineClassName: "editor-blame",
              cursorStops: monaco.editor.InjectedTextCursorStops.None,
            },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            showIfCollapsed: true,
          },
        },
      ]);
    };
    paint();
    const subCursor = code.onDidChangeCursorPosition(paint);

    const mine: Instance = {
      code,
      paint,
      dispose: () => {
        clearTimeout(safety);
        cancelAnimationFrame(painted);
        scrolled.dispose();
        subMove.dispose();
        subLeave.dispose();
        subCursor.dispose();
        dropCard();
        ghosts.clear();
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
      m.place = code.saveViewState();
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
    const s = session.current;
    if (!code || !s || line === undefined || s.revealedFor === openSeq) return;
    s.revealedFor = openSeq;
    const model = s.modified;
    const ln = Math.max(1, Math.min(line, model.getLineCount()));
    // on the line's first character rather than its indent: for a picked element that is the tag
    // itself. A blank line has no first character and reports 0.
    code.setPosition({ lineNumber: ln, column: model.getLineFirstNonWhitespaceColumn(ln) || 1 });
    code.revealLineInCenter(ln);
  });

  // the keyboard follows a file opened on purpose, once per open; one walked to in a list stays there
  useOnChange([openSeq], () => {
    const s = session.current;
    if (!focus || !s || s.focusedFor === openSeq) return;
    s.focusedFor = openSeq;
    instance.current?.code.focus();
  });

  return (
    <>
      <div ref={ref} className="editor-monaco" onWheelCapture={passPinch} />
      {card && (
        // the tooltip's own card, in its parts: who at the head with their address as the name,
        // what the commit said as the detail, and the sha and the date as the figures at the foot
        <Float className="tooltip tooltip-card" anchor={() => card.anchor} placement={CARD_PLACEMENT} aria-hidden>
          <div className="tooltip-head">
            <span>{card.commit.author || card.commit.sha.slice(0, 7)}</span>
            {card.commit.email && <span className="tooltip-name">{card.commit.email}</span>}
          </div>
          <div className="tooltip-detail">{card.commit.subject || "no message"}</div>
          <div className="tooltip-foot">
            <span className="editor-blame-sha">{card.commit.sha.slice(0, 7)}</span>
            <span>{CARD_DATE.format(card.commit.at)}</span>
          </div>
        </Float>
      )}
    </>
  );
}
