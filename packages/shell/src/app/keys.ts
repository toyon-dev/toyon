import { matchChord, worktreeIndex } from "@toyon/shared";
import { useEffect } from "react";
import { useSock, useStoreInstance } from "../state/context.tsx";
import { isSubPicker } from "../state/store.ts";
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
      if (chord) {
        e.preventDefault();
        switch (chord.id) {
          case "worktree": {
            const i = worktreeIndex(chord.digit, s.worktrees.length);
            const wt = i === null ? undefined : s.worktrees[i];
            if (wt) dispatch({ a: "activate", id: wt.worktree.id });
            break;
          }
          case "new":
            dispatch({ a: "toggle", overlay: { kind: "prompt" } });
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
          case "commands":
            dispatch({ a: "toggle", overlay: { kind: "commands" } });
            break;
          case "zen":
            dispatch({ a: "toggle-zen" });
            break;
          case "left":
            dispatch({ a: "toggle-left" });
            break;
          case "right":
            dispatch({ a: "toggle-right" });
            break;
          case "keys":
            dispatch({ a: "toggle", overlay: { kind: "keys" } });
            break;
          case "terminal":
            dispatch({ a: "toggle-terminal" });
            break;
        }
      } else if (e.key === "Escape") {
        if (s.overlay) {
          // sub-pickers go back to the palette they came from; everything else just closes
          dispatch({ a: "close", back: isSubPicker(s.overlay) });
        } else if (s.picking) {
          // (while picking, the bridge cancels on its own Escape; this covers focus in the shell)
          if (s.activeId) previewBus.post(s.activeId, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        } else if (s.zen) dispatch({ a: "toggle-zen" });
        // bottom panes, terminal first (a full-screen program in it keeps Escape for itself)
        else if (s.termOpen) dispatch({ a: "toggle-terminal" });
        else if (s.diff) dispatch({ a: "close-diff" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, sock]);
}
