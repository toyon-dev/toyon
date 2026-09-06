// Lazy-loaded xterm.js terminal for one worktree (React.lazy, like MonacoDiff: the bundle only
// downloads when a pane is first opened). Frames come straight off the socket via terminalBus.

import { hex8, matchChord, type Theme } from "@toyon/shared";
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
    background: c.bg0,
    foreground: c.fg1,
    cursor: c.fg1,
    cursorAccent: c.bg0,
    selectionBackground: hex8(c.bg3, 0.6),
    black: c.bg1,
    red: c.red,
    green: c.green,
    yellow: c.yellow,
    blue: c.blue,
    magenta: c.purple,
    cyan: c.aqua,
    white: c.fgMuted,
    brightBlack: c.fgDim,
    brightRed: c.red,
    brightGreen: c.green,
    brightYellow: c.yellow,
    brightBlue: c.blue,
    brightMagenta: c.purple,
    brightCyan: c.aqua,
    brightWhite: c.fg1,
  };
}

function monoFont(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return v || "ui-monospace, Menlo, monospace";
}

export default function XTerm({
  worktreeId,
  theme,
  sock,
  connected,
  onAlive,
}: {
  worktreeId: string;
  theme: Theme;
  sock: DaemonSocket | null;
  connected: boolean;
  /** the shell's state as the daemon reports it: alive after a snapshot, dead (with its code) on exit */
  onAlive: (alive: boolean, exitCode?: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onAliveRef = useRef(onAlive);
  onAliveRef.current = onAlive;

  useEffect(() => {
    const el = box.current;
    if (!el || !sock) return;
    const term = new Terminal({
      theme: toXtermTheme(themeRef.current),
      fontFamily: monoFont(),
      fontSize: 12,
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
      // escape belongs to whatever runs in here (vim), not to the shell's escape ladder
      if (e.key === "Escape") e.stopPropagation();
      return true;
    });
    const input = term.onData((d) => {
      for (let i = 0; i < d.length; i += INPUT_CHUNK) {
        sock.send({ t: "term-input", worktreeId, data: d.slice(i, i + INPUT_CHUNK) });
      }
    });
    const resized = term.onResize(({ cols, rows }) => sock.send({ t: "term-resize", worktreeId, cols, rows }));
    const off = terminalBus.on(worktreeId, (m) => {
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
      sock.send({ t: "term-close", worktreeId });
      term.dispose();
      termRef.current = null;
    };
  }, [worktreeId, sock]);

  // (re)open on every connection: the first time this mounts, and after a reconnect, when the
  // daemon may have restarted (fresh shell) or only the socket dropped (same shell, replayed)
  useEffect(() => {
    const term = termRef.current;
    if (!connected || !sock || !term) return;
    sock.send({ t: "term-open", worktreeId, cols: term.cols, rows: term.rows });
  }, [connected, sock, worktreeId]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = toXtermTheme(theme);
  }, [theme]);

  return <div className="term-host" ref={box} />;
}
