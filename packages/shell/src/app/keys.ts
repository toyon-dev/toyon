import { matchChord, SHELL_STREAM, worktreeIndex } from "@toyon/shared";
import { useEffect } from "react";
import { useSock, useStoreInstance } from "../state/context.tsx";
import { isSubPicker, localOf } from "../state/store.ts";
import { previewBus, togglePick } from "./previewBus.ts";

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
      if (chord) {
        e.preventDefault();
        switch (chord.id) {
          case "worktree": {
            const i = worktreeIndex(chord.digit, s.visible.length);
            const wt = i === null ? undefined : s.visible[i];
            if (wt) dispatch({ a: "activate", id: wt.id });
            break;
          }
          case "new":
            dispatch({ a: "toggle", overlay: { kind: "prompt" } });
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
          case "pick":
            if (s.activeId) togglePick(s.activeId, s.picking, dispatch);
            break;
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
          case "left":
            // a plain toggle: open it or shut it. Opening hands it the keyboard, but a second
            // press closes it rather than stopping to focus a panel that is already on screen.
            if (s.leftOpen) dispatch({ a: "toggle-left" });
            else dispatch({ a: "focus-left" });
            break;
          case "right":
            dispatch({ a: "toggle-right" });
            break;
          case "rail":
            dispatch({ a: "toggle-rail" });
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
          if (s.activeId) previewBus.post(s.activeId, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        }
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
