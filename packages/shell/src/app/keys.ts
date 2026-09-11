import { type ChordId, matchChord, SHELL_STREAM, worktreeIndex } from "@toyon/shared";
import { useEffect } from "react";
import { useSock, useStoreInstance } from "../state/context.tsx";
import { isSubPicker, localOf, previewIdOf } from "../state/store.ts";
import { previewBus, togglePick } from "./previewBus.ts";
import { railWalk } from "./railWalk.ts";
import { unseenJump } from "./unseenJump.ts";

/** the chords a focused Monaco keeps for itself (see the check in useChords) */
const MONACO_OWNS = new Set<ChordId>(["design", "new", "wt-prev", "wt-next", "wt-unseen-prev", "wt-unseen-next"]);

/** Global chords (the table lives in shared/chords.ts) and Escape. Reads the store directly inside
 * the handler so the listener is installed once instead of re-subscribing on every state change. */
export function useChords() {
  const store = useStoreInstance();
  const sock = useSock();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = store.getState();
      const { dispatch } = store;
      const chord = matchChord(e);
      // zen mirrors the bridge: the preview owns the keyboard and only the chord that leaves zen
      // is ours, so a flow under test keeps Escape and its own hotkeys. An overlay or the element
      // picker holds shell focus, so those keep the full ladder or there is no way back out.
      if (s.zen && !s.overlay && !s.picking && chord?.id !== "zen") return;
      // ⌘D and ⌘K are Monaco's (add cursor, chord prefix) while it has the keyboard, and so are
      // ⌥↑/↓ (move line) and ⌥⇧↑/↓ (copy line); taking them from a focused editor made a design
      // scan out of a second cursor, and would make a worktree switch out of a line move. ⌘L is
      // taken from it anyway: expand-line-selection is the loss, and a hand in the editor that
      // wants to answer the agent is who the chord is for.
      const monaco = !!document.activeElement?.closest(".monaco-editor");
      if (monaco && chord && MONACO_OWNS.has(chord.id)) return;
      if (chord) {
        e.preventDefault();
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
            break;
          }
          case "wt-unseen-prev":
          case "wt-unseen-next": {
            const to = unseenJump(s.visible, s.activeId, !!s.draft, chord.id === "wt-unseen-next" ? 1 : -1);
            if (to && "draft" in to) dispatch({ a: "open-draft" });
            else if (to) dispatch({ a: "activate", id: to.activate });
            break;
          }
          case "new":
            // the chord means "get me to the box", not a switch: pressed blind with a draft
            // already open it keeps the draft and puts the caret back in it, so a hand that has
            // not looked is never dropped back on the row it left. The rail's row still toggles,
            // since a click on the picked row is a deliberate second look; Escape is the way back.
            if (s.draft) dispatch({ a: "focus-right" });
            else dispatch({ a: "open-draft" });
            break;
          case "project":
            // the picker hangs off the pill, and zen hides the bar it lives in: leave zen first
            // so the chord opens something visible
            if (s.zen && s.overlay?.kind !== "projects") dispatch({ a: "toggle-zen" });
            dispatch({ a: "toggle", overlay: { kind: "projects" } });
            break;
          case "quick-open":
            if (s.overlay?.kind === "quick-open") dispatch({ a: "close" });
            else if (s.activeId) {
              sock?.send({ t: "list-files", worktreeId: s.activeId });
              dispatch({ a: "open", overlay: { kind: "quick-open" } });
            }
            break;
          case "pick": {
            // the frame on screen, which while drafting is the base's preview rather than the row's
            const id = previewIdOf(s);
            if (id) togglePick(id, s.picking, dispatch);
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
          // the panel chords are plain toggles: open it or shut it. Opening hands it the keyboard
          // (the changes list, the composer, the current worktree row), but a second press closes
          // it rather than stopping to focus a panel that is already on screen. ⌘L is the chord
          // that only focuses.
          case "left":
            if (s.leftOpen) dispatch({ a: "toggle-left" });
            else dispatch({ a: "focus-left" });
            break;
          case "right":
            if (s.rightOpen) dispatch({ a: "toggle-right" });
            else dispatch({ a: "focus-right" });
            break;
          case "composer":
            dispatch({ a: "focus-right" });
            break;
          case "rail":
            if (s.railOpen) dispatch({ a: "toggle-rail" });
            else dispatch({ a: "focus-rail" });
            break;
          case "keys":
            dispatch({ a: "toggle", overlay: { kind: "keys" } });
            break;
          case "terminal":
            dispatch({ a: "toggle-terminal" });
            break;
          case "design":
            dispatch({ a: "toggle-design" });
            break;
          case "term-tab": {
            const wt = s.rows.find((w) => w.id === s.activeId);
            if (!wt) break;
            const streams = [SHELL_STREAM, ...wt.procs.map((p) => p.name)];
            const at = streams.indexOf(localOf(s, s.activeId).termStream);
            dispatch({
              a: "term-stream",
              id: wt.id,
              stream: streams[(at + 1) % streams.length] ?? SHELL_STREAM,
            });
            break;
          }
        }
      } else if (e.key === "Escape") {
        if (s.overlay) {
          // sub-pickers go back to the palette they came from; everything else just closes
          dispatch({ a: "close", back: isSubPicker(s.overlay) });
        } else if (s.picking) {
          // (while picking, the bridge cancels on its own Escape; this covers focus in the shell)
          const id = previewIdOf(s);
          if (id) previewBus.post(id, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        }
        // the draft tab: back to the row it was from. What was typed stays in its record, so the
        // next open picks it up rather than starting over.
        else if (s.draft) dispatch({ a: "close-draft" });
        // an import pane: stop watching it. Escape deliberately does NOT abort the clone, which
        // keeps running and stays in the switcher: it is a key people hit reflexively, and losing
        // a five-minute download to one is not a trade worth making. Stopping it is the button.
        else if (s.activeImportId) dispatch({ a: "watch-import", id: null });
        // bottom panes, terminal first (a full-screen program in it keeps Escape for itself).
        // Zen is not on this ladder: it only leaves on ⌘., so Escape stays the page's own key
        else if (s.termOpen) dispatch({ a: "toggle-terminal" });
        else if (s.diff) dispatch({ a: "close-diff" });
        else if (s.designOpen) dispatch({ a: "toggle-design" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
