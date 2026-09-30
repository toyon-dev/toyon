// Lazy-loaded xterm.js terminal for one of a worktree's streams (React.lazy, like the editor: the
// bundle only downloads when a pane is first opened). Frames come straight off the socket via terminalBus.

import { accentOf, chordOf, composite, hex8, matchChord, streamKey, type Theme } from "@toyon/shared";
import { FitAddon } from "@xterm/addon-fit";
import { type ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { terminalBus } from "../../app/terminalBus.ts";
import { FindBox } from "../../ui/FindBox.tsx";
import { isFind } from "../../ui/find.ts";
import { useOnChange } from "../../ui/hooks.ts";
import type { DaemonSocket } from "../../ws.ts";

/** a paste arrives as one onData; the protocol caps a term-input frame at 64K */
const INPUT_CHUNK = 16 * 1024;

/** the 16 ANSI slots from the shell's seven hues: bright colors reuse the normal ones (the theme
 * contract has no ANSI block yet), black/white come from the surface and text scale */
export function toXtermTheme(t: Theme): ITheme {
  const c = t.colors;
  return {
    background: c.surface0,
    foreground: c.text0,
    cursor: c.text0,
    cursorAccent: c.surface0,
    selectionBackground: hex8(c.border1, 0.6),
    black: c.surface1,
    red: c.red,
    green: c.green,
    yellow: c.yellow,
    blue: c.blue,
    magenta: c.purple,
    cyan: c.aqua,
    white: c.text1,
    brightBlack: c.text2,
    brightRed: c.red,
    brightGreen: c.green,
    brightYellow: c.yellow,
    brightBlue: c.blue,
    brightMagenta: c.purple,
    brightCyan: c.aqua,
    brightWhite: c.text0,
  };
}

/** the wash on a match, as the document find and the editor's own paint theirs: every match, and
 * the one the reader is on darker. xterm takes an opaque colour only, so the accent is laid over
 * the terminal's ground here rather than by the browser. */
const washOf = (t: Theme, alpha: number) => composite(hex8(accentOf(t), alpha), t.colors.surface0);

function findColors(t: Theme): ISearchOptions {
  const accent = accentOf(t);
  return {
    decorations: {
      matchBackground: washOf(t, 0.18),
      activeMatchBackground: washOf(t, 0.38),
      // the ruler is off; the type asks for its colours all the same
      matchOverviewRuler: accent,
      activeMatchColorOverviewRuler: accent,
    },
  };
}

/** Find in the terminal is ⌘F alone. The terminal is a guest keyboard, and ⌃F is the program's:
 * a page down in less and vim, a character forward at the prompt. */
const isTermFind = (e: KeyboardEvent) => isFind(e) && e.metaKey && !e.ctrlKey;

/** xterm marks no more than this many matches, and past it cannot say which one the reader is on */
const FIND_LIMIT = 1000;

function monoFont(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--face-mono").trim();
  return v || "ui-monospace, Menlo, monospace";
}

/* --type-mono is a `font` shorthand and xterm wants a number, so the size lives apart from it in
   --size-mono. The terminal is the only code surface on the body tier: the diff pane and the tool
   log both read --size-mono-sm, so the three are 12/11/11 and not one size. That split is the
   number to re-derive once the face changes, since 12-under-13 was measured against SF Mono. */
function monoSize(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--size-mono");
  return Number.parseFloat(v) || 12;
}

export default function XTerm({
  worktreeId,
  stream,
  theme,
  sock,
  connected,
  focusOnMount,
  focusReq,
  onAlive,
  run,
  onRan,
  onEscape,
}: {
  worktreeId: string;
  /** which of the worktree's streams this tab shows: SHELL_STREAM or a proc name */
  stream: string;
  theme: Theme;
  sock: DaemonSocket | null;
  connected: boolean;
  /** take the keyboard on mount: this terminal was asked for, rather than carried along open by a
   * switch to its worktree (read once, as the terminal opens) */
  focusOnMount: boolean;
  /** the store's focusTerm: a bump asks for the keyboard */
  focusReq: number;
  /** the shell's state as the daemon reports it: alive after a snapshot, dead (with its code) on exit */
  onAlive: (alive: boolean, exitCode?: number) => void;
  /** a command to type at the prompt as soon as the shell is up, then `onRan` */
  run: string | null;
  onRan: () => void;
  /** Escape at the prompt (xterm stops propagation on every key it consumes, so the window
   * ladder never sees it; the pane closes itself instead) */
  onEscape: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  // ⌘F in the pane: the browser's find reads only the rows on screen, and the rail and the chat
  // with them; this one reads the scrollback. A selection at the press is what is looked for.
  const [find, setFind] = useState<{ seed: string; seq: number } | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState({ at: -1, count: 0 });
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onAliveRef = useRef(onAlive);
  onAliveRef.current = onAlive;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const onRanRef = useRef(onRan);
  onRanRef.current = onRan;
  const takeFocus = useRef(focusOnMount);
  // the shell has answered: a snapshot of a live pty, or output after it came back. Input sent
  // before that goes to a pty that may not exist yet.
  const [up, setUp] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || !sock) return;
    const term = new Terminal({
      theme: toXtermTheme(themeRef.current),
      fontFamily: monoFont(),
      // a `font` shorthand is not parseable, so the size is held apart in --size-mono. The diff
      // pane reads --size-mono-sm instead; see monoSize above.
      fontSize: monoSize(),
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      // the wash on a found match is a decoration, which xterm still files under its proposed API
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon({ highlightLimit: FIND_LIMIT });
    term.loadAddon(search);
    term.open(el);
    fit.fit();
    termRef.current = term;
    searchRef.current = search;
    const counted = search.onDidChangeResults((r) => setFound({ at: r.resultIndex, count: r.resultCount }));
    // The key is taken on the pane, so a hand on the tab strip means the terminal too. The box
    // answers its own ⌘F; a native listener here runs before React's, so that one is left to it.
    const pane = el.closest<HTMLElement>("[data-pane]") ?? el;
    const onFind = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isTermFind(e) || (e.target as Element).closest(".find")) return;
      e.preventDefault();
      e.stopPropagation();
      const picked = term.getSelection();
      const seed = picked.trim() && !picked.includes("\n") ? picked : "";
      setFind((f) => ({ seed: seed || f?.seed || "", seq: (f?.seq ?? 0) + 1 }));
    };
    pane.addEventListener("keydown", onFind);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // xterm skips it and the pane's listener above answers
      if (isTermFind(e)) return false;
      // ⌘K clears, as in Terminal.app; while the terminal has focus, new-worktree is ⌘N or the palette
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        term.clear();
        return false;
      }
      // a toyon chord is the shell's: xterm skips it and the event bubbles up to useChords. The
      // terminal is a guest keyboard, so ⌃R stays the shell program's history search, and a chord
      // every text field keeps (⌥⌫, ⌥←/→) is the program's word delete and word jump here.
      const chord = matchChord(e, { guest: true });
      if (chord && !chordOf(chord.id).textKeeps) return false;
      // a full-screen program (vim, less) is on the alternate buffer and owns Escape
      if (e.key === "Escape" && term.buffer.active.type !== "alternate") {
        e.preventDefault();
        onEscapeRef.current();
        return false;
      }
      return true;
    });
    // A snapshot is the pty's raw output replayed, queries included: the terminal answers the
    // device-attribute, cursor-position and mode reports in it as if the program had just asked,
    // and a full-screen program that asked once at startup reads the second round as keystrokes
    // (vim takes the `$y` of a blink report as an operator, and `i` then never inserts). Nothing
    // the terminal says while a snapshot is being written is a hand's, so none of it is sent. A
    // count, not a flag: two opens in flight (a reconnect on the heels of a mount) replay two
    // snapshots, and the first finishing must not let the second's answers through.
    let replaying = 0;
    const input = term.onData((d) => {
      if (replaying > 0) return;
      for (let i = 0; i < d.length; i += INPUT_CHUNK) {
        sock.send({ t: "term-input", worktreeId, stream, data: d.slice(i, i + INPUT_CHUNK) });
      }
    });
    const resized = term.onResize(({ cols, rows }) => sock.send({ t: "term-resize", worktreeId, stream, cols, rows }));
    // a proc the supervisor respawns keeps its stream, so no snapshot follows its exit: the first
    // thing it prints is what says it is back
    let dead = false;
    const off = terminalBus.on(streamKey(worktreeId, stream), (m) => {
      if (m.t === "term-data") {
        term.write(m.data);
        if (dead) {
          dead = false;
          onAliveRef.current(true);
        }
        setUp(true);
      } else if (m.t === "term-snapshot") {
        // the daemon replays raw output into a fresh terminal (a reopen, a reconnect, a respawn)
        term.reset();
        replaying++;
        term.write(m.data, () => {
          replaying--;
        });
        dead = !m.alive;
        onAliveRef.current(m.alive);
        setUp(m.alive);
      } else {
        term.write(`\r\n\x1b[2m[exited ${m.exitCode}]\x1b[0m\r\n`);
        dead = true;
        onAliveRef.current(false, m.exitCode);
        setUp(false);
      }
    });
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(el);
    if (takeFocus.current) term.focus();
    return () => {
      ro.disconnect();
      off();
      input.dispose();
      resized.dispose();
      counted.dispose();
      pane.removeEventListener("keydown", onFind);
      // the matches were this terminal's
      setFind(null);
      setQuery("");
      sock.send({ t: "term-close", worktreeId, stream });
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
  }, [worktreeId, stream, sock]);

  // (re)open on every connection: the first time this mounts, and after a reconnect, when the
  // daemon may have restarted (fresh shell) or only the socket dropped (same shell, replayed)
  useEffect(() => {
    const term = termRef.current;
    if (!connected || !sock || !term) return;
    sock.send({ t: "term-open", worktreeId, stream, cols: term.cols, rows: term.rows });
  }, [connected, sock, worktreeId, stream]);

  // xterm holds the match the reader is on as its selection, and its DOM renderer paints a
  // selection over any decoration: while the box is open the selection is the darker wash, focused
  // or not, so the current match reads as it does in a document
  const finding = find !== null;
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const current = washOf(theme, 0.38);
    term.options.theme = finding
      ? { ...toXtermTheme(theme), selectionBackground: current, selectionInactiveBackground: current }
      : toXtermTheme(theme);
  }, [theme, finding]);

  // typed as if at the keyboard, return included, so it lands in the shell's own history
  useEffect(() => {
    if (!run || !up || !sock) return;
    sock.send({ t: "term-input", worktreeId, stream, data: `${run}\r` });
    onRanRef.current();
  }, [run, up, sock, worktreeId, stream]);

  // ⌘J from outside an open pane asks for the keyboard by bumping a counter. Only a bump seen after
  // mount counts: a press that opened the pane, or remounted it on another worktree, is already
  // answered by the focus on mount (Center reads the bump into focusOnMount).
  const answered = useRef(focusReq);
  useOnChange([focusReq], () => {
    if (focusReq === answered.current) return;
    answered.current = focusReq;
    termRef.current?.focus();
  });

  // A query typed is looked for from the newest line up, since the foot of the output is where the
  // reader is; typing more of it stays on the match it has while that still fits. An empty query
  // clears the wash.
  const look = (next: string) => {
    setQuery(next);
    const search = searchRef.current;
    if (!search) return;
    if (next) search.findPrevious(next, findColors(themeRef.current));
    else {
      search.clearDecorations();
      termRef.current?.clearSelection();
      setFound({ at: -1, count: 0 });
    }
  };
  const step = (dir: 1 | -1) => {
    if (!query) return;
    if (dir === 1) searchRef.current?.findNext(query, findColors(themeRef.current));
    else searchRef.current?.findPrevious(query, findColors(themeRef.current));
  };
  // the box goes, the match stays as the terminal's selection, and the keyboard is the prompt's again
  const closeFind = () => {
    setFind(null);
    setQuery("");
    setFound({ at: -1, count: 0 });
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };
  const status = !query
    ? ""
    : found.count === 0
      ? "no matches"
      : found.at < 0
        ? `${found.count}+`
        : `${found.at + 1}/${found.count}`;

  return (
    <>
      <div className="term-host" ref={box} />
      {find && (
        <FindBox
          label="find in the terminal"
          query={query}
          onQuery={look}
          seed={find.seed}
          seq={find.seq}
          status={status}
          none={found.count === 0}
          onStep={step}
          onClose={closeFind}
        />
      )}
    </>
  );
}
