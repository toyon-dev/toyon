import { type ChordId, LOGIN_STREAM, matchChord, SHELL_STREAM, worktreeIndex } from "@toyon/shared";
import { useEffect } from "react";
import { markUnread } from "../state/actions/worktree.ts";
import { useSock, useStoreInstance } from "../state/context.tsx";
import { isChatCentred, isSubPicker, localOf, previewIdOf, routeTarget } from "../state/store.ts";
import { previewBus, togglePick } from "./previewBus.ts";
import { PEEK_FALLBACK_MS, type WalkModifier, walkModifier } from "./railPeek.ts";
import { railWalk } from "./railWalk.ts";
import { unseenJump } from "./unseenJump.ts";

/** the keyboard is somewhere inside `selector` */
const inside = (selector: string) => !!document.activeElement?.closest(selector);

/** the ⌘ chords a focused Monaco keeps for itself; it keeps every ⌥ one too (see useChords) */
const MONACO_OWNS = new Set<ChordId>(["design", "new", "routes"]);

/** the chords that answer on the new-project view: the rest act on a worktree, and the page is about
 * a project that has none yet, over one that is not on screen */
const VIEW_CHORDS = new Set<ChordId>(["project", "commands", "keys", "zen"]);

/** Global chords (the table lives in shared/chords.ts) and Escape. Reads the store directly inside
 * the handler so the listener is installed once instead of re-subscribing on every state change. */
export function useChords() {
  const store = useStoreInstance();
  const sock = useSock();
  useEffect(() => {
    // The walk's peek (railPeek.ts): the modifier the last walk press rode, while the collapsed
    // rail is held open for it, and the timer that closes the peek if that key's release is
    // never seen. Holding the modifier and pressing again keeps the same peek and resets the timer.
    let peekMod: WalkModifier | null = null;
    let peekTimer: ReturnType<typeof setTimeout> | undefined;
    const endPeek = () => {
      clearTimeout(peekTimer);
      peekMod = null;
      store.dispatch({ a: "rail-peek", on: false });
    };
    const peek = (e: KeyboardEvent) => {
      // a pinned rail is already wide; the peek is only for the strip
      if (store.getState().railOpen) return;
      peekMod = walkModifier(e);
      clearTimeout(peekTimer);
      peekTimer = setTimeout(endPeek, PEEK_FALLBACK_MS);
      store.dispatch({ a: "rail-peek", on: true });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (peekMod && e.key === peekMod) endPeek();
    };
    const onKey = (e: KeyboardEvent) => {
      const s = store.getState();
      const { dispatch } = store;
      // a key xterm let through for the program in it can still bubble here, so a focused terminal
      // is matched as the guest keyboard it is and keeps its ⌃R
      const chord = matchChord(e, { guest: !!document.activeElement?.closest(".xterm") });
      // zen mirrors the bridge: the preview owns the keyboard and only the chord that leaves zen
      // is ours, so a flow under test keeps Escape and its own hotkeys. An overlay or the element
      // picker holds shell focus, so those keep the full ladder or there is no way back out.
      // A zen left on by another project is not in force on one with nothing to run, which has no page.
      if (s.zen && !isChatCentred(s) && !s.overlay && !s.picking && chord?.id !== "zen") return;
      // ⌘D, ⌘K and ⌘G are Monaco's (add cursor, chord prefix, find next) while it has the keyboard, and
      // so is every ⌥ chord: ⌥↑/↓ is move line and ⌥⇧↑/↓ copy line. Taking them from a focused editor
      // made a design scan out of a second cursor, and would make a worktree switch out of a line move;
      // the same walk on ⌃Tab binds nothing in Monaco and stays ours. ⌘L is taken from it anyway:
      // expand-line-selection is the loss, and a hand in the editor that wants to answer the agent
      // is who the chord is for. ⌘E and ⌘I are taken too, and Editor.tsx unbinds Monaco's own keys
      // for them so the keydown gets here: the picker is the same chord wherever the hand is.
      const monaco = !!document.activeElement?.closest(".monaco-editor");
      if (monaco && chord && (e.altKey || MONACO_OWNS.has(chord.id))) return;
      if (chord) {
        e.preventDefault();
        if (s.newProject && !VIEW_CHORDS.has(chord.id)) return;
        switch (chord.id) {
          case "worktree": {
            const i = worktreeIndex(chord.digit, s.visible.length);
            const wt = i === null ? undefined : s.visible[i];
            if (wt) dispatch({ a: "activate", id: wt.id });
            break;
          }
          case "wt-prev":
          case "wt-next": {
            const to = railWalk(s.visible, s.visibleDiscovered, s.activeId, !!s.draft, chord.id === "wt-next" ? 1 : -1);
            if (to && "draft" in to) dispatch({ a: "open-draft" });
            else if (to) dispatch({ a: "activate", id: to.activate });
            // the peek shows the row landed on, and a walk with nowhere to go shows why
            peek(e);
            break;
          }
          case "wt-unseen-prev":
          case "wt-unseen-next": {
            const to = unseenJump(s.visible, s.activeId, !!s.draft, chord.id === "wt-unseen-next" ? 1 : -1);
            if (to && "draft" in to) dispatch({ a: "open-draft" });
            else if (to) dispatch({ a: "activate", id: to.activate });
            break;
          }
          case "mark-unread":
            // the worktree on screen, when it is one of ours; a draft is not a worktree yet
            if (s.activeId && !s.draft && s.visible.some((w) => w.id === s.activeId)) {
              markUnread(sock, dispatch, s.activeId);
            }
            break;
          case "new":
            // the chord means "get me to the box", not a switch: pressed blind with a draft
            // already open it keeps the draft and puts the caret back in it, so a hand that has
            // not looked is never dropped back on the row it left. The rail's row still toggles,
            // since a click on the picked row is a deliberate second look; Escape is the way back.
            if (s.draft) dispatch({ a: "focus-right" });
            else dispatch({ a: "open-draft" });
            break;
          case "project":
            // over the preview, where the eyes are when a key is pressed; the pill's dropdown is for
            // a click that is already up in the corner
            dispatch({ a: "toggle", overlay: { kind: "projects", form: "center" } });
            break;
          case "quick-open":
            if (s.overlay?.kind === "quick-open") dispatch({ a: "close" });
            else if (s.activeId) {
              sock?.send({ t: "list-files", worktreeId: s.activeId });
              dispatch({ a: "open", overlay: { kind: "quick-open" } });
            }
            break;
          case "routes":
            // the address bar's own list, which has nowhere to go until the preview is up
            if (s.overlay?.kind === "routes") dispatch({ a: "close" });
            else if (routeTarget(s)) dispatch({ a: "open", overlay: { kind: "routes" } });
            break;
          case "pick":
          case "inspect": {
            // the frame on screen, which while drafting is the base's preview rather than the row's
            const id = previewIdOf(s);
            if (id) togglePick(id, s.picking, dispatch, chord.id === "pick" ? "chat" : "code");
            break;
          }
          case "search":
            if (s.activeId) dispatch({ a: "toggle", overlay: { kind: "search" } });
            break;
          case "refs":
            if (s.activeRepoId) dispatch({ a: "toggle", overlay: { kind: "refs" } });
            break;
          case "commands":
            dispatch({ a: "toggle", overlay: { kind: "commands" } });
            break;
          case "zen":
            dispatch({ a: "toggle-zen" });
            break;
          // the panel chords answer where the keyboard is. From anywhere else they open the panel if
          // it is shut and hand it the keyboard (the changes list, the chat box, the terminal, the
          // current worktree row); from inside that spot they close it. A press that shut a panel
          // already on screen took it from a hand that had come to type in it.
          case "left":
            dispatch(s.leftOpen && inside(".changes-list") ? { a: "toggle-left" } : { a: "focus-left" });
            break;
          case "composer":
            // a chat in the centre is not a panel: there is nothing to close, only the box to reach
            dispatch(
              s.rightOpen && !isChatCentred(s) && inside(".chat-input") ? { a: "toggle-right" } : { a: "focus-right" },
            );
            break;
          case "rail":
            dispatch(s.railOpen && inside(".rail-list") ? { a: "toggle-rail" } : { a: "focus-rail" });
            break;
          case "keys":
            dispatch({ a: "toggle", overlay: { kind: "keys" } });
            break;
          case "terminal":
            dispatch(s.termOpen && inside(".xterm") ? { a: "toggle-terminal" } : { a: "focus-terminal" });
            break;
          case "design":
            dispatch({ a: "toggle-design" });
            break;
          case "term-tab": {
            const wt = s.rows.find((w) => w.id === s.activeId);
            if (!wt) break;
            const current = localOf(s, s.activeId).termStream;
            // a login on screen is the pane's only tab, so there is nothing to walk to
            if (wt.login && current === LOGIN_STREAM) break;
            const streams = [SHELL_STREAM, ...(wt.login ? [LOGIN_STREAM] : []), ...wt.procs.map((p) => p.name)];
            const at = streams.indexOf(current);
            dispatch({
              a: "term-stream",
              id: wt.id,
              stream: streams[(at + 1) % streams.length] ?? SHELL_STREAM,
            });
            break;
          }
        }
      } else if (e.key === "Escape") {
        // The Finder dialog is another app's window. An Escape that reaches the page while it is up
        // was meant for it, so it closes the dialog and leaves the form it was opened from alone.
        if (s.choosingFolder) {
          sock?.send({ t: "cancel-folder" });
          dispatch({ a: "choosing-folder", v: false });
        } else if (s.overlay) {
          // sub-pickers go back to the palette they came from; everything else just closes
          dispatch({ a: "close", back: isSubPicker(s.overlay) });
        }
        // the new-project view: back to the project behind it, unless the page is waiting on an answer
        else if (s.newProject) {
          if (s.newProject.phase === "editing") dispatch({ a: "close-new-project" });
        } else if (s.picking) {
          // (while picking, the bridge cancels on its own Escape; this covers focus in the shell)
          const id = previewIdOf(s);
          if (id) previewBus.post(id, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        }
        // the draft tab: back to the row it was from. What was typed stays in its record, so the
        // next open picks it up rather than starting over.
        else if (s.draft) dispatch({ a: "close-draft" });
        // an archived worktree's page: back to the row it is over
        else if (s.archivedPage) dispatch({ a: "close-archived" });
        // an import pane: stop watching it. Escape deliberately does NOT abort the clone, which
        // keeps running and stays in the switcher: it is a key people hit reflexively, and losing
        // a five-minute download to one is not a trade worth making. Stopping it is the button.
        else if (s.activeImportId) dispatch({ a: "watch-import", id: null });
        // bottom panes, terminal first (a full-screen program in it keeps Escape for itself).
        // Zen is not on this ladder: it only leaves on ⌘., so Escape stays the page's own key
        else if (s.termOpen) dispatch({ a: "toggle-terminal" });
        else if (s.editor) dispatch({ a: "close-editor" });
        else if (s.designOpen) dispatch({ a: "toggle-design" });
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    // the release lands in whatever window took the keyboard, so leaving this one ends the peek
    window.addEventListener("blur", endPeek);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", endPeek);
      clearTimeout(peekTimer);
    };
  }, [store, sock]);

  // The picker's second verb rides alt and its second destination rides shift, and the chord that
  // armed the picker left focus in the shell: the frame sees no key at all until something is
  // clicked inside it. Mirror them in for the same reason Escape is mirrored above, keyup included,
  // or the fill outlives the hold.
  useEffect(() => {
    const onMod = (e: KeyboardEvent) => {
      if (e.key !== "Alt" && e.key !== "Shift") return;
      const s = store.getState();
      if (s.picking && s.activeId) {
        previewBus.post(s.activeId, { type: "pick-mods", alt: e.altKey, shift: e.shiftKey });
      }
    };
    window.addEventListener("keydown", onMod);
    window.addEventListener("keyup", onMod);
    return () => {
      window.removeEventListener("keydown", onMod);
      window.removeEventListener("keyup", onMod);
    };
  }, [store]);
}
