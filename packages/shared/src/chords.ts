// The keyboard chords, once. The shell's key handler, the bridge's forwarder (chords pressed
// while the preview has focus), the shortcuts card and the palette hints all derive from this
// table, so a chord can't be handled in one place and forgotten in another.
//
// Dependency-free on purpose: the bridge bundle imports this file.

export type ChordId =
  | "quick-open"
  | "commands"
  | "search"
  | "chats"
  | "changes"
  | "files"
  | "panel-tab-prev"
  | "panel-tab-next"
  | "composer"
  | "rail"
  | "keys"
  | "pick"
  | "inspect"
  | "zen"
  | "new"
  | "terminal"
  | "design"
  | "term-tab"
  | "worktree"
  | "wt-prev"
  | "wt-next"
  | "wt-unseen-prev"
  | "wt-unseen-next"
  | "mark-unread"
  | "project"
  | "refs"
  | "routes"
  | "reload"
  | "back"
  | "forward"
  | "close";

/** what the shell knows about the browser it runs in; each flag can swap an advertised key */
export interface ChordEnv {
  firefox?: boolean;
  pwa?: boolean;
}

export interface Chord {
  id: ChordId;
  /** the key as KeyboardEvent.key, lower-case for letters; "1-9" for the worktree switcher */
  key: string;
  shift?: boolean;
  /** bound and advertised as ⌃ rather than ⌘: for keys macOS takes before a browser sees them (⌘`
   * cycles windows), where every editor settled on the ⌃ form. ⌘ still counts when it does arrive
   * (an installed app window with nothing to cycle to). */
  ctrl?: true;
  /** bound and advertised as ⌥ with no ⌘: only for the arrow rows. ⌥ with a letter is how macOS
   * types a symbol and ⌥ with ⌘ is Monaco's cursor family, but an arrow types nothing, so ⌥↑/↓ can
   * be the next-and-previous pair the way it is in Slack. */
  alt?: true;
  /** the same chord again on ⌃, with a key and ⇧ of its own: ⌃Tab and ⌃⇧Tab walk the worktrees
   * the way they walk a terminal's tabs. Every browser tab takes ⌃Tab before the page; an
   * installed app window has no tabs and hands it over, so that is where it is advertised.
   * `hostOnly` leaves the alias to a guest keyboard (a terminal, a previewed page) that already has
   * a use for it, the way Zed's terminal keeps ⌃R. */
  ctrlAlias?: { key: string; shift?: true; hostOnly?: true };
  /** the same chord again on ⌘⇧, for keys of its own: ⌘⇧[ and ⌘⇧] step through tabs in iTerm2,
   * Ghostty and every editor. Both spellings of a bracket are listed because with ⇧ held a browser
   * may report the shifted character, and the bridge forwards only `key`. A browser tab keeps both
   * for its own tabs, so like ⌃Tab they reach the page in an installed app. A letter is listed once:
   * the matcher lower-cases it. Never advertised. */
  cmdShiftAlias?: string[];
  /** other ⌘ keys that fire the same chord: ⌘N for new-worktree because it is the muscle-memory
   * key, though only an installed PWA lets the page see it (Chrome tabs, Safari and Firefox all
   * take ⌘N as new window before the page). */
  aliases?: string[];
  /** a key with no modifier at all that fires the same chord: F1 for the palette, as in VS Code and
   * Cursor, and the key Firefox users are shown because Firefox owns ⌘⇧P. */
  bareAlias?: string;
  /** a focused text field keeps the chord: ⌥←/→ is a word jump in every field, editor and shell */
  textKeeps?: true;
}

export const CHORDS: readonly Chord[] = [
  { id: "quick-open", key: "p" },
  {
    id: "commands",
    key: "p",
    shift: true,
    bareAlias: "F1",
  },
  { id: "search", key: "f", shift: true },
  // ⌘G searches every chat in the project, Slack's pair: ⌘F finds in the conversation on screen,
  // and stays the browser's for that, and ⌘G looks through all of them. A focused Monaco keeps ⌘G
  // as find-next (app/keys.ts), and a browser's open find bar keeps it while it has the keyboard.
  { id: "chats", key: "g" },
  // ⌘B is the panel with your files in VS Code, Cursor and Zed, whichever side it stands on here.
  // ⌃⇧G is the git panel in VS Code and Zed and stays a hidden alias for the hand that knows it.
  // Both open the panel on its changes tab, whichever tab it was left on.
  { id: "changes", key: "b", ctrlAlias: { key: "g", shift: true } },
  // ⌘⇧E is the file tree's key in VS Code, Cursor and Zed, and here it opens the same panel on its
  // files tab
  { id: "files", key: "e", shift: true },
  // ⌥←/→ walk the panel's tabs the way ⌥↑/↓ walk the worktrees beside it. Anywhere text is typed
  // (the composer, the commit box, the editor, the terminal, a field on the page) keeps it as the
  // word jump it is there.
  { id: "panel-tab-prev", key: "ArrowLeft", alt: true, textKeeps: true },
  { id: "panel-tab-next", key: "ArrowRight", alt: true, textKeeps: true },
  // ⌘L is Cursor's key for the chat, so it is the one a hand already reaches for, and the chat's only
  // chord: from elsewhere it puts the caret in the box, opening the panel if it must, and from the
  // box it closes the panel (app/keys.ts). From the editor it brings the selection along as Cursor's
  // does (the editor answers it there, since Monaco keeps the key). A tab may lose it to the address
  // bar, an installed app always sees it.
  { id: "composer", key: "l" },
  // ⌘⇧K next to ⌘K: one makes a worktree, the other shows the panel of them. No alias: ⌘⇧L was
  // one, and it is add-to-chat in Cursor and select-all-matches in VS Code and Zed, so it caught
  // a reflex meant for something else. The rail is walked without opening it (⌥↑/↓, ⌘1-9), and
  // the palette and the bar button reach the toggle where the key does not.
  { id: "rail", key: "k", shift: true },
  // ⌘, is the macOS preferences key, and unlike ⌘N/⌘T/⌘W a page may preempt it in a tab as
  // well as in an installed app, so it is ours everywhere. ⌘/ is deliberately not bound: it is
  // toggle-comment in Monaco (and every editor), and the shell listens on window.
  { id: "keys", key: "," },
  // ⌘J is the bottom panel in VS Code, Cursor and Zed, and the terminal is what lives there. ⌃` is
  // their terminal key as well and stays for the hand that knows it; a page reaches it from a tab
  // and an app window alike, where ⌘` never arrives (macOS cycles windows with it).
  { id: "terminal", key: "j", ctrlAlias: { key: "`" } },
  { id: "design", key: "d" },
  // a focused xterm swallows nearly everything, so tab cycling needs a chord matchChord catches
  { id: "term-tab", key: "`", ctrl: true, shift: true },
  { id: "pick", key: "e" },
  // ⌘I is the same picker with the source as the click and ⌥ back to the chat: ⌘E adds an element
  // to the message, ⌘I jumps to its code, a key short of the browser's ⌘⌥I
  { id: "inspect", key: "i" },
  { id: "zen", key: "." },
  {
    id: "new",
    key: "k",
    aliases: ["n"],
  },
  { id: "worktree", key: "1-9" },
  // ⌥↑/↓ walk the rail the way ⌥↑/↓ walk Slack's channels, ⌃Tab and ⌘⇧[/] the way they walk a
  // terminal's tabs; ⌘1-9 jumps by position. A focused Monaco hands ⌥↑/↓ over as well: Editor.tsx
  // unbinds its move-line so the walk is the same key from inside the editor.
  {
    id: "wt-prev",
    key: "ArrowUp",
    alt: true,
    ctrlAlias: { key: "Tab", shift: true },
    cmdShiftAlias: ["[", "{"],
  },
  { id: "wt-next", key: "ArrowDown", alt: true, ctrlAlias: { key: "Tab" }, cmdShiftAlias: ["]", "}"] },
  // ⌥⇧↑/↓ is Slack's next-unread: the nearest worktree whose agent is waiting on you, else the
  // nearest with a turn nobody has looked at, else the nearest still working, and the walk's end
  // (main, the draft) when the rail is quiet. Down is on the shortcuts card; up is for the hand
  // that already knows it.
  { id: "wt-unseen-prev", key: "ArrowUp", alt: true, shift: true },
  { id: "wt-unseen-next", key: "ArrowDown", alt: true, shift: true },
  // ⌘⇧U is Mail's mark-as-unread: the ring goes back on the worktree on screen, to come back to.
  // Monaco binds only ⌘U (cursor undo) and ⌘K ⌘U, so a focused editor lets it through.
  { id: "mark-unread", key: "u", shift: true },
  // ⌘O is "Open..." in VS Code on macOS and in vscode.dev, which takes it from the browser's own
  // open-file dialog the same way. ⌘⇧O opens it too. It is go-to-symbol in VS Code and Monaco, and a
  // focused editor still answers it that way, because Monaco stops the keydown for a key it binds.
  // ⌃R is open-recent in VS Code and Zed, and reverse history search in every shell, so a focused
  // terminal keeps it, and so does a previewed page, which may be a terminal of its own.
  { id: "project", key: "o", ctrlAlias: { key: "r", hostOnly: true }, cmdShiftAlias: ["o"] },
  // ⌘⇧G: G for git, the work elsewhere, a branch or a PR. A browser only uses it as find-previous
  // while its find bar is open, which a page may preempt; every other ⌘⇧ letter that reads as
  // "git" or "branch" is taken before the page sees it
  { id: "refs", key: "g", shift: true },
  // U for URL: the address bar's list, since ⌘L is the chat's and ⌘G searches the chats. Only Firefox has
  // a use for ⌘U (view source); Monaco's cursor-undo on it is unbound (Editor.tsx).
  { id: "routes", key: "u" },
  // ⌘R reloads the preview, the frame the hand is looking at, not the shell around it. ⌘⇧R is left
  // to the browser: its hard reload takes the shell and every preview with it, which is what the
  // bigger reload should mean. With no preview up there is no frame to mean, so the shell lets ⌘R
  // through to the browser (app/keys.ts). An installed app always hands ⌘R over; a tab may keep it.
  { id: "reload", key: "r" },
  // ⌘←/→ are the browser's back and forward, and with a preview up they step that frame, the page
  // the hand is looking at, the same way ⌘R reloads it. Left to the browser they walk the tab's
  // joint history, which is the preview's entries and then the shell's own, so a press with nothing
  // behind the frame would take the tab out of the shell. In a field the pair is the caret's jump
  // to the line's ends and stays so. With no preview up they are the browser's (app/keys.ts).
  { id: "back", key: "ArrowLeft", textKeeps: true },
  { id: "forward", key: "ArrowRight", textKeeps: true },
  // ⌘W closes the bottom pane Escape would (app/keys.ts), and keeps the window. In an installed app
  // the browser would close the window on it, and the hand that presses it there was closing a
  // terminal tab or an editor tab the way iTerm and VS Code taught it; the daemon keeps every agent
  // and process, so nothing is lost, but the shell is a dock click away for nothing gained. The row
  // also makes the bridge forward it from a focused preview instead of letting that frame's ⌘W
  // close the window. A browser tab takes ⌘W before the page sees it, and the shell lets it
  // through in one that does not, so the chord is only ever live in an installed app. ⌘Q stays the
  // app menu's: no key event reaches the page, and quitting is what it says. Never advertised.
  { id: "close", key: "w" },
];

/** the chords that still act in zen, where the preview owns the keyboard: the one that leaves
 * zen, ⌘W, which with the panes off screen only keeps the app's window where it is, and ⌘←/→,
 * which mean the page's own back and forward there as everywhere and, left to the browser,
 * could walk the tab out of the shell */
export const ZEN_CHORDS: ReadonlySet<ChordId> = new Set<ChordId>(["zen", "close", "back", "forward"]);

export type ChordMatch = { id: Exclude<ChordId, "worktree"> } | { id: "worktree"; digit: number };

/** Normalised chord detection for a keydown: ⌘ (no ⌃/⌥) for most rows, ⌃ alone for the rows that
 * ask for it and for a row's ⌃ alias, ⌘⇧ for a row's ⌘⇧ alias, ⌥ alone for the arrow rows, no
 * modifier at all for a row's bare alias; letters
 * case-insensitive so a browser that reports "F" for ⌘⇧F and one that reports "f" agree; shift must
 * match the table exactly (⌘⇧B is not ⌘B). `guest` is a keydown from a keyboard with uses of its own
 * (a terminal, a previewed page), which keeps every `hostOnly` alias. */
export function matchChord(
  e: {
    key: string;
    metaKey: boolean;
    shiftKey: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
  },
  { guest = false }: { guest?: boolean } = {},
): ChordMatch | null {
  if (e.altKey) {
    if (e.metaKey || e.ctrlKey) return null;
    const c = CHORDS.find((c) => c.alt && c.key === e.key && !!c.shift === e.shiftKey);
    return c && c.id !== "worktree" ? { id: c.id } : null;
  }
  // a bare key is the kind a program in the terminal or a previewed page binds itself (F1 is help
  // in most of them), so a guest keyboard keeps every bare alias
  if (!e.metaKey && !e.ctrlKey) {
    if (e.shiftKey || guest) return null;
    const c = CHORDS.find((c) => c.bareAlias === e.key);
    return c && c.id !== "worktree" ? { id: c.id } : null;
  }
  if (!!e.ctrlKey === e.metaKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.metaKey && !e.shiftKey && key >= "1" && key <= "9") return { id: "worktree", digit: Number(key) };
  for (const c of CHORDS) {
    if (c.id === "worktree") continue;
    const a = c.ctrlAlias;
    if (a && e.ctrlKey && a.key === key && !!a.shift === e.shiftKey && !(guest && a.hostOnly)) return { id: c.id };
    if (e.metaKey && e.shiftKey && c.cmdShiftAlias?.includes(key)) return { id: c.id };
    if (c.alt) continue;
    // a ⌘ row never fires on ⌃; a ⌃ row fires on either
    if ((e.ctrlKey && !c.ctrl) || !!c.shift !== e.shiftKey) continue;
    if (c.key === key || c.aliases?.includes(key)) return { id: c.id };
  }
  return null;
}

export function chordOf(id: ChordId): Chord {
  const c = CHORDS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown chord ${id}`);
  return c;
}

/** the ⌘N chord that reaches worktree i of count, if any: ⌘1–8 by position, ⌘9 always the last one */
export function worktreeChord(i: number, count: number): string | undefined {
  if (i === count - 1) return "⌘9";
  return i < 8 ? `⌘${i + 1}` : undefined;
}

/** ⌘9 is the last worktree (macOS tab convention); ⌘1–8 by position */
export function worktreeIndex(digit: number, count: number): number | null {
  if (count === 0) return null;
  if (digit === 9) return count - 1;
  return digit - 1 < count ? digit - 1 : null;
}

/** the keyboard is in something text is typed into: a field, a textarea (Monaco's and xterm's
 * included) or an editable element. Structural, so the daemon can import this file without the DOM. */
export function isTyping(el: unknown): boolean {
  const e = el as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!e?.tagName) return false;
  if (e.isContentEditable || e.tagName === "TEXTAREA") return true;
  return e.tagName === "INPUT" && !["button", "checkbox", "radio", "range", "submit", "reset"].includes(e.type ?? "");
}
