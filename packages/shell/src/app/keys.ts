import { matchChord, worktreeIndex } from "@toyon/shared";
import { useEffect } from "react";
import type { Store } from "../state/context.tsx";
import { previewBus } from "./previewBus.ts";

/** Global chords (the table lives in shared/chords.ts) and Escape. Reads the store directly inside
 * the handler so the listener is installed once instead of re-subscribing on every state change. */
export function useChords(store: Store, send: (msg: { t: "list-files"; worktreeId: string }) => void) {
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
              send({ t: "list-files", worktreeId: s.activeId });
              dispatch({ a: "open", overlay: { kind: "quick-open" } });
            }
            break;
          case "pick":
            if (s.picking) {
              if (s.activeId) previewBus.post(s.activeId, { type: "pick-cancel" });
              dispatch({ a: "set-picking", v: false });
            } else if (s.activeId) {
              previewBus.post(s.activeId, { type: "pick-start" });
              dispatch({ a: "set-picking", v: true });
            }
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
        }
      } else if (e.key === "Escape") {
        if (s.overlay) {
          // sub-pickers go back to the palette they came from; everything else just closes
          dispatch({ a: "close", back: s.overlay.kind === "theme" || s.overlay.kind === "appearance" });
        } else if (s.picking) {
          // (the bridge handles esc itself when the preview has focus; this covers focus in the shell)
          if (s.activeId) previewBus.post(s.activeId, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        } else if (s.zen) dispatch({ a: "toggle-zen" });
        else if (s.diff) dispatch({ a: "close-diff" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, send]);
}
