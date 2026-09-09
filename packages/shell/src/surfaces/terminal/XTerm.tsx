// Lazy-loaded xterm.js terminal for one of a worktree's streams (React.lazy, like MonacoDiff: the
// bundle only downloads when a pane is first opened). Frames come straight off the socket via terminalBus.

import { hex8, matchChord, streamKey, type Theme } from "@toyon/shared";
import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { terminalBus } from "../../app/terminalBus.ts";
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

function monoFont(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return v || "ui-monospace, Menlo, monospace";
}

/* --type-mono is a `font` shorthand and xterm wants a number, so the size lives apart from it in
   --type-mono-px. MonacoDiff reads the same token, which is what keeps the three code surfaces
   (terminal, diff, tool log) at one size. */
function monoSize(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--type-mono-px");
  return Number.parseFloat(v) || 12;
}

export default function XTerm({
  worktreeId,
  stream,
  theme,
  sock,
  connected,
  onAlive,
  onEscape,
}: {
  worktreeId: string;
  /** which of the worktree's streams this tab shows: SHELL_STREAM or a proc name */
  stream: string;
  theme: Theme;
  sock: DaemonSocket | null;
  connected: boolean;
  /** the shell's state as the daemon reports it: alive after a snapshot, dead (with its code) on exit */
  onAlive: (alive: boolean, exitCode?: number) => void;
  /** Escape at the prompt (xterm stops propagation on every key it consumes, so the window
   * ladder never sees it; the pane closes itself instead) */
  onEscape: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onAliveRef = useRef(onAlive);
  onAliveRef.current = onAlive;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    const el = box.current;
    if (!el || !sock) return;
    const term = new Terminal({
      theme: toXtermTheme(themeRef.current),
      fontFamily: monoFont(),
      // the same token the diff pane reads: a `font` shorthand is not parseable, so the size is
      // held apart in --type-mono-px and both editors take it from there
      fontSize: monoSize(),
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // ⌘K clears, as in Terminal.app; while the terminal has focus, new-worktree is ⌘N or the palette
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        term.clear();
        return false;
      }
      // a toyon chord is the shell's: xterm skips it and the event bubbles up to useChords
      if (matchChord(e)) return false;
      // a full-screen program (vim, less) is on the alternate buffer and owns Escape
      if (e.key === "Escape" && term.buffer.active.type !== "alternate") {
        e.preventDefault();
        onEscapeRef.current();
        return false;
      }
      return true;
    });
    const input = term.onData((d) => {
      for (let i = 0; i < d.length; i += INPUT_CHUNK) {
        sock.send({ t: "term-input", worktreeId, stream, data: d.slice(i, i + INPUT_CHUNK) });
      }
    });
    const resized = term.onResize(({ cols, rows }) => sock.send({ t: "term-resize", worktreeId, stream, cols, rows }));
    const off = terminalBus.on(streamKey(worktreeId, stream), (m) => {
      if (m.t === "term-data") term.write(m.data);
      else if (m.t === "term-snapshot") {
        // the daemon replays raw output into a fresh terminal (a reopen, a reconnect, a respawn)
        term.reset();
        term.write(m.data);
        onAliveRef.current(m.alive);
      } else {
        term.write(`\r\n\x1b[2m[exited ${m.exitCode}]\x1b[0m\r\n`);
        onAliveRef.current(false, m.exitCode);
      }
    });
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(el);
    term.focus();
    return () => {
      ro.disconnect();
      off();
      input.dispose();
      resized.dispose();
      sock.send({ t: "term-close", worktreeId, stream });
      term.dispose();
      termRef.current = null;
    };
  }, [worktreeId, stream, sock]);

  // (re)open on every connection: the first time this mounts, and after a reconnect, when the
  // daemon may have restarted (fresh shell) or only the socket dropped (same shell, replayed)
  useEffect(() => {
    const term = termRef.current;
    if (!connected || !sock || !term) return;
    sock.send({ t: "term-open", worktreeId, stream, cols: term.cols, rows: term.rows });
  }, [connected, sock, worktreeId, stream]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = toXtermTheme(theme);
  }, [theme]);

  return <div className="term-host" ref={box} />;
}
