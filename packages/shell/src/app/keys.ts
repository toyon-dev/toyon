import {
  type ChordId,
  fieldKeeps,
  isBrowserSave,
  LOGIN_STREAM,
  matchChord,
  SHELL_STREAM,
  worktreeIndex,
  ZEN_CHORDS,
  zenChord,
} from "@toyon/shared";
import { useEffect } from "react";
import { markUnread, worktreeActions } from "../state/actions/worktree.ts";
import { useSock, useStoreInstance } from "../state/context.tsx";
import {
  type Action,
  archivedPageOf,
  changesTabShown,
  changesTabStep,
  chatChordAction,
  isChatCentred,
  isDrafted,
  isFirstRun,
  localOf,
  previewIdOf,
  previewReload,
  routeTarget,
} from "../state/store.ts";
import { viewedStep } from "../state/viewed.ts";
import { isInstalledApp } from "../surfaces/util.ts";
import type { PaneKind } from "../ui/Pane.tsx";
import { previewBus, togglePick } from "./previewBus.ts";
import { createHeldRun, createWalkPeek } from "./railPeek.ts";
import { railWalk } from "./railWalk.ts";
import { unseenJump } from "./unseenJump.ts";

/** the chords a focused Monaco keeps for itself (see useChords) */
const MONACO_OWNS = new Set<ChordId>(["design", "chats"]);

/** the chords that step the previewed page's history, and so mean nothing without one */
const PAGE_CHORDS = new Set<ChordId>(["back", "forward"]);

/** the chords that walk the worktrees viewed, whose run a held ⌘ keeps going (railPeek.ts) */
const VIEWED_CHORDS = new Set<ChordId>(["wt-back", "wt-forward"]);

/** the chords that answer on the new-project view: the rest act on a worktree, and the page is about
 * a project that has none yet, over one that is not on screen */
const VIEW_CHORDS = new Set<ChordId>(["project", "commands", "keys", "zen"]);

/** Global chords (the table lives in shared/chords.ts) and Escape. Reads the store directly inside
 * the handler so the listener is installed once instead of re-subscribing on every state change. */
export function useChords() {
  const store = useStoreInstance();
  const sock = useSock();
  useEffect(() => {
    // The walk's peek (railPeek.ts): the collapsed rail held open for the modifier the walk rode,
    // once the hold has earned it. A tap switches and shows nothing; the rail lasts exactly as long
    // as that key stays down after that: its keyup ends it, and so does the first key or pointer
    // event that reports the key up, for a release that was never seen.
    const walkPeek = createWalkPeek((on) => store.dispatch({ a: "rail-peek", on }));
    const endPeek = walkPeek.end;
    const peek = (e: KeyboardEvent) => {
      // a pinned rail is already wide; the peek is only for the strip
      if (store.getState().railOpen) return;
      walkPeek.press(e);
    };
    // the viewed walk's run (railPeek.ts): a step lands the caret in a composer, and a draft there
    // would keep the next ⌘←/→ as its caret jump; while the ⌘ the first step rode stays down, the
    // next press is a step whatever the field holds
    const heldRun = createHeldRun();
    const onKeyUp = (e: KeyboardEvent) => {
      walkPeek.keyup(e.key);
      heldRun.keyup(e.key);
    };
    const onMods = (e: KeyboardEvent | PointerEvent) => {
      walkPeek.mods(e);
      heldRun.mods(e);
    };
    /** the pane holding the keyboard, since a click into a pane says which is meant. With none
     * holding it, terminal first (a full-screen program in it keeps Escape for itself). */
    const closePane = () => {
      const s = store.getState();
      const held = document.activeElement?.closest<HTMLElement>("[data-pane]")?.dataset.pane as PaneKind | undefined;
      const pane = held ?? (s.layout.term ? "terminal" : s.editor ? "editor" : s.layout.design ? "design" : null);
      if (pane === "terminal") store.dispatch({ a: "toggle-terminal" });
      else if (pane === "editor") store.dispatch({ a: "close-editor" });
      else if (pane === "design") store.dispatch({ a: "toggle-design" });
    };
    // The Finder dialog is another app's window. An Escape that reaches the page while it is up
    // was meant for it, so it closes the dialog and nothing else: not the form it was opened from,
    // and not whatever holds the caret, which is why this is taken on the way down.
    const onFolderEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !store.getState().choosingFolder) return;
      e.stopImmediatePropagation();
      sock?.send({ t: "cancel-folder" });
      store.dispatch({ a: "choosing-folder", v: false });
    };
    const onKey = (e: KeyboardEvent) => {
      onMods(e);
      // ⌘S from the composer, a list, a palette: the browser's Save Page As, a Finder sheet over the
      // app, for a hand that was saving a file autosave already wrote. The editor's save-now and the
      // terminal (⌃S is a shell's flow control, and xterm stops the key it sent) both claim theirs
      // before the window hears it, so what arrives unclaimed was for nobody.
      if (isBrowserSave(e) && !e.defaultPrevented) e.preventDefault();
      const s = store.getState();
      const { dispatch } = store;
      // a walk or a digit that lands on a row is there to read and reply, so the composer is offered
      // the caret. Who held it is read now: a carried terminal or editor remounts on the switch, and
      // a frame later the body holds a caret that was theirs.
      const land = (id: string, by: Action = { a: "activate", id }) => {
        const held = document.activeElement;
        const offer = !held || held === document.body || !!held.closest(".rail, .chat-input");
        dispatch(by);
        if (offer) dispatch({ a: "walked" });
      };
      // a key xterm let through for the program in it can still bubble here, so a focused terminal
      // is matched as the guest keyboard it is and keeps its ⌃R
      const pressed = matchChord(e, { guest: !!document.activeElement?.closest(".xterm") });
      // zen mirrors the bridge: the preview owns the keyboard and only the chord that leaves zen
      // (and ⌘W, which keeps the window) is ours, so a flow under test keeps Escape and its own
      // hotkeys. An overlay or the element picker holds shell focus, so those keep the full ladder
      // or there is no way back out. A zen left on by another project is not in force on one with
      // nothing to run, which has no page. With zen in force ⌘←/→ are the page's history (zenChord).
      const inZen = s.zen && !isChatCentred(s);
      const chord = inZen ? zenChord(pressed) : pressed;
      if (inZen && !s.overlay && !s.picking && !(chord && ZEN_CHORDS.has(chord.id))) return;
      // ⌘W is only ever swallowed in an installed app, where it would close the window. A browser
      // tab takes it before the page sees it, and one that hands it over is asking about the tab.
      if (chord?.id === "close" && !isInstalledApp()) return;
      // ⌘D and ⌘G are Monaco's (add cursor, find next) while it has the keyboard: a hand fixing a
      // line reaches for both, and taking ⌘D made a design scan out of a second cursor. Everything
      // else is the same chord wherever the hand is: Editor.tsx unbinds Monaco's own keys for ⌘E,
      // ⌘I, F1, ⌥↑/↓, ⌥⇧↑/↓ and ⌘U so the keydown gets here, and answers ⌘L and ⌘K itself, since
      // Monaco keeps those two from the window (⌘K is the prefix of its chord family).
      const monaco = !!document.activeElement?.closest(".monaco-editor");
      if (monaco && chord && MONACO_OWNS.has(chord.id)) return;
      // the terminal and the editor type into a textarea of their own, so this covers them as well.
      // A viewed-walk step under the ⌘ an earlier step rode is a step, draft or no draft.
      const inRun = chord && VIEWED_CHORDS.has(chord.id) && heldRun.holds(e);
      if (chord && !inRun && fieldKeeps(chord.id, document.activeElement)) return;
      // with no page up (setup, a stopped app, an update waiting on a reload, a chat) ⌘←/→ are the
      // browser's again: the shell is the only thing on screen they could mean
      if (chord && PAGE_CHORDS.has(chord.id) && !(previewIdOf(s) && routeTarget(s))) return;
      // ⌘R too, but only where nothing on screen could be a preview: a row whose app is down still
      // has the boot pane standing in for one, and a reload there asks for the app back rather than
      // taking the whole shell down around it
      if (chord?.id === "reload" && !previewReload(s)) return;
      if (chord) {
        const claimed = e.defaultPrevented;
        e.preventDefault();
        if (s.newProject && !VIEW_CHORDS.has(chord.id)) return;
        switch (chord.id) {
          case "worktree": {
            const i = worktreeIndex(chord.digit, s.visible.length);
            const wt = i === null ? undefined : s.visible[i];
            // no peek: there is no held modifier to read the landed row against
            if (wt) land(wt.id);
            break;
          }
          case "wt-prev":
          case "wt-next": {
            const to = railWalk(s.visible, s.visibleDiscovered, s.activeId, chord.id === "wt-next" ? 1 : -1);
            if (to) land(to.activate);
            // the peek shows the row landed on, and a walk with nowhere to go shows why
            peek(e);
            break;
          }
          case "wt-unseen-prev":
          case "wt-unseen-next": {
            const to = unseenJump(s.visible, s.activeId, chord.id === "wt-unseen-next" ? 1 : -1);
            if (to) land(to.activate);
            // same hold as the walk: the peek shows which row was worth the look
            peek(e);
            break;
          }
          case "wt-back":
          case "wt-forward": {
            // back and forward through the rows chosen by hand, over any row since gone; the
            // step moves the stand in the list rather than writing to it
            const live = new Set(s.rows.map((w) => w.id));
            const to = viewedStep(s.viewed, live, s.activeId, chord.id === "wt-forward" ? 1 : -1);
            if (to) {
              land(to.activate, { a: "viewed-land", at: to.at });
              heldRun.press(e);
            }
            // the peek shows the row landed on, as it does for the rail walk
            peek(e);
            break;
          }
          case "mark-unread":
            // the worktree on screen, when it is one of ours; main has no turns to mark
            if (s.activeId && !s.draft && s.visible.some((w) => w.id === s.activeId)) {
              markUnread(sock, dispatch, s.activeId);
            }
            break;
          case "wt-archive": {
            // the worktree on screen, through the same confirm its menu line gives it. Not under
            // an archived page, which sits over the row the key would otherwise take. A repeat is
            // a held word delete that ran the field dry, and a key the field already answered
            // (the composer dropping an attachment) is spent.
            if (e.repeat || claimed) break;
            const w = s.draft || s.archivedPage ? undefined : s.visible.find((w) => w.id === s.activeId);
            if (w) worktreeActions(sock, dispatch, (id) => isDrafted(s, id)).archive(w);
            break;
          }
          case "new":
            // main's box, with the caret in it; from main itself this is only the caret
            dispatch({ a: "open-draft" });
            break;
          case "project":
            // over the preview, where the eyes are when a key is pressed; the pill's dropdown is for
            // a click that is already up in the corner
            dispatch({ a: "toggle", overlay: { kind: "projects", form: "center" } });
            break;
          case "quick-open":
            if (s.overlay?.kind === "quick-open") dispatch({ a: "close" });
            else if (s.activeId) dispatch({ a: "open", overlay: { kind: "quick-open" } });
            break;
          case "routes":
            // the address bar's own list, which has nowhere to go until the preview is up
            if (s.overlay?.kind === "routes") dispatch({ a: "close" });
            else if (routeTarget(s)) dispatch({ a: "open", overlay: { kind: "routes" } });
            break;
          case "reload": {
            // the frame on screen, or with its app down the daemon's start of it (a press with
            // neither went to the browser)
            const to = previewReload(s);
            if (!to) break;
            if (to.act === "frame") previewBus.post(to.id, { type: "reload" });
            else sock?.send({ t: "preview-start", worktreeId: to.id });
            break;
          }
          case "back":
          case "forward": {
            // the frame on screen only, which is up by now (a press with none went to the browser)
            const id = previewIdOf(s);
            if (id) previewBus.post(id, { type: chord.id });
            break;
          }
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
          case "chats":
            if (s.activeRepoId) dispatch({ a: "toggle", overlay: { kind: "chats" } });
            break;
          case "commands":
            dispatch({ a: "toggle", overlay: { kind: "commands" } });
            break;
          case "zen":
            dispatch({ a: "toggle-zen" });
            break;
          case "close":
            // the preventDefault above keeps the window; what closes is the pane Escape would, the
            // one the hand pressing ⌘W was closing in the terminal or editor it learned it from. In
            // zen the panes are off screen, and under a palette the pane is not what is being
            // looked at, so there the window staying is the whole chord.
            if (!(s.zen && !isChatCentred(s)) && !s.overlay) closePane();
            break;
          // the panel chords toggle, wherever the keyboard is: a panel on screen shuts, and a shut
          // one opens with the keyboard in it (the changes list, the chat box, the terminal, the
          // current worktree row).
          // the two panel keys each name a tab, so a press from the other tab lands on the one the
          // key names rather than shutting a panel that was not showing it. An archived page's one
          // list is its changes list.
          case "changes":
            dispatch(
              s.layout.changes && (changesTabShown(s) === "changes" || archivedPageOf(s) !== null)
                ? { a: "toggle-changes" }
                : { a: "focus-changes", tab: "changes" },
            );
            break;
          case "files":
            dispatch(
              s.layout.changes && changesTabShown(s) === "files"
                ? { a: "toggle-changes" }
                : { a: "focus-changes", tab: "files" },
            );
            break;
          // a shut panel opens on the tab it was left on, so the first press shows where the walk
          // starts rather than stepping past a tab nobody has seen yet. The keyboard follows the tab
          // from wherever it was: the next key after picking a tab is an arrow into it.
          case "panel-tab-prev":
          case "panel-tab-next":
            if (isFirstRun(s)) break;
            dispatch(
              s.layout.changes
                ? { a: "focus-changes", tab: changesTabStep(s, chord.id === "panel-tab-next" ? 1 : -1) }
                : { a: "focus-changes" },
            );
            break;
          case "composer":
            dispatch(chatChordAction(s));
            break;
          case "rail":
            dispatch(s.railOpen ? { a: "toggle-rail" } : { a: "focus-rail" });
            break;
          case "keys":
            dispatch({ a: "toggle", overlay: { kind: "keys" } });
            break;
          case "terminal":
            dispatch(s.layout.term ? { a: "toggle-terminal" } : { a: "focus-terminal" });
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
        // An open box is not on this ladder: it takes its Escape as the topmost float
        // (ui/Overlay.tsx), ahead of whatever holds the caret under it.
        // the new-project view: back to the project behind it, unless the page is waiting on an answer
        if (s.newProject) {
          if (s.newProject.phase === "editing") dispatch({ a: "close-new-project" });
        } else if (s.picking) {
          // (while picking, the bridge cancels on its own Escape; this covers focus in the shell)
          const id = previewIdOf(s);
          if (id) previewBus.post(id, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        }
        // the release notes, or an archived worktree's page: back to the row it is over
        else if (s.notesPage) dispatch({ a: "close-release-notes" });
        else if (s.archivedPage) dispatch({ a: "close-archived" });
        // an import pane: stop watching it. Escape deliberately does NOT abort the clone, which
        // keeps running and stays in the switcher: it is a key people hit reflexively, and losing
        // a five-minute download to one is not a trade worth making. Stopping it is the button.
        else if (s.activeImportId) dispatch({ a: "watch-import", id: null });
        // bottom panes, the ladder's last rung, which ⌘W reaches directly.
        // Zen is not on this ladder: it only leaves on ⌘., so Escape stays the page's own key
        else closePane();
      }
    };
    window.addEventListener("keydown", onFolderEscape, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointermove", onMods);
    window.addEventListener("pointerdown", onMods);
    // the release lands in whatever window took the keyboard, so leaving this one ends the peek
    window.addEventListener("blur", endPeek);
    return () => {
      window.removeEventListener("keydown", onFolderEscape, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointermove", onMods);
      window.removeEventListener("pointerdown", onMods);
      window.removeEventListener("blur", endPeek);
      // a hold still waiting to earn the rail must not open it after the listeners are gone
      endPeek();
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
