import { useEffect, useRef } from "react";
import { appItems } from "../state/actions/app.ts";
import { restoreArchived } from "../state/actions/archive.ts";
import { removeWorktrees } from "../state/actions/worktree.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../state/context.tsx";
import { STORAGE } from "../state/keys.ts";
import { useActive, useActiveId, useActiveRow, useFirstRun, useRows, useTheme } from "../state/selectors.ts";
import { Center } from "../surfaces/center/Center.tsx";
import { LeftDock } from "../surfaces/changes/LeftDock.tsx";
import { RightDock } from "../surfaces/chat/RightDock.tsx";
import { useFileDrop } from "../surfaces/chat/useIntake.ts";
import { WtRail } from "../surfaces/rail/WtRail.tsx";
import { StatusBar } from "../surfaces/statusbar/StatusBar.tsx";
import { clampW } from "../surfaces/util.ts";
import { applyTheme, bridgeThemeMsg, onPrefersDarkChange } from "../theme.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Float } from "../ui/Float.tsx";
import { floats } from "../ui/floats.ts";
import { useDragResize, useOnChange, usePersisted } from "../ui/hooks.ts";
import { Menus } from "../ui/Menu.tsx";
import { useContextMenu } from "../ui/menu.ts";
import { Tooltips } from "../ui/Tooltip.tsx";
import { useChords } from "./keys.ts";
import { previewBus } from "./previewBus.ts";
import "./app.css";
import { cx } from "../ui/cx.ts";

/** the worktree rail: the strip it keeps when it peeks, and the column it takes when kept open
 *  (both also in rail.css, as the rail's width and --rail-width) */
const RAIL_PX = 40;
const RAIL_OPEN_PX = 280;
const MRU_SUBSCRIPTIONS = 3;
/** how long a worktree stays on screen, with the window focused, before its unseen ring clears */
const SEEN_AFTER_MS = 2000;
/** the least time between recounts on coming back to the window */
const RECOUNT_AFTER_MS = 5000;

/** Where the browser's own menu is the useful one and ours would take it away: anything typed
 * into (spelling, paste), the terminal (paste), Monaco, and the preview, which is the person's
 * site and not our chrome. Everything else on the page answers with the app menu. */
const NATIVE_MENU = "input, textarea, [contenteditable], .monaco-editor, .xterm, iframe";

/** layout + app-wide effects; every surface reads its own state through selectors */
export function App() {
  const store = useStoreInstance();
  const dispatch = useDispatch();
  const sock = useSock();
  const activeId = useActiveId();
  const activeRepoId = useStore((s) => s.activeRepoId);
  const active = useActive();
  const activeRow = useActiveRow();
  const connected = useStore((s) => s.connected);
  const zen = useStore((s) => s.zen);
  const firstRun = useFirstRun();
  // both docks are hidden, not closed, on the new-project page and while the composer sits in the
  // centre of an empty project. So is the rail: on the page it lists a project that is not the one
  // being made, and on an empty project its only row is main, already open, with no new worktree to
  // offer, since one off the root commit would take the scaffold to a branch while main stayed blank.
  const leftOpen = useStore((s) => s.leftOpen) && !firstRun;
  const rightOpen = useStore((s) => s.rightOpen) && !firstRun;
  const railOpen = useStore((s) => s.railOpen);
  const panels = useStore((s) => s.panels);
  const lastActive = useStore((s) => s.lastActive);
  const discoveredOpen = useStore((s) => s.discoveredOpen);
  const archivedOpen = useStore((s) => s.archivedOpen);
  const theme = useTheme();
  const previewing = useStore((s) => s.previewTheme !== null);
  const toast = useStore((s) => s.toast);
  const clientId = useStore((s) => s.clientId);
  const rows = useRows();

  // the stack every float registers in: it decides which float a press or a key belongs to, and
  // closes the ones it does not
  useEffect(() => floats.install(window), []);

  // the daemon streams only subscribed worktrees. Keep the last few visited subscribed so their
  // previews still reload after an agent turn while hidden and switching back is instant; drop
  // the oldest beyond that. A reconnect re-subscribes the whole set.
  const subsRef = useRef<string[]>([]);
  useEffect(() => {
    // any row, owned or found: a found worktree streams nothing but its git status, and that is
    // what its badges and the changes panel read
    if (!sock || !connected || !activeId) return;
    const mru = [activeId, ...subsRef.current.filter((id) => id !== activeId)];
    for (const gone of mru.splice(MRU_SUBSCRIPTIONS)) sock.send({ t: "unsubscribe", worktreeId: gone });
    // only the newcomer needs a subscribe (and its backfill); the others have been streaming all along
    if (!subsRef.current.includes(activeId)) sock.send({ t: "subscribe", worktreeId: activeId });
    subsRef.current = mru;
  }, [activeId, connected, sock]);
  // a reconnect is a new socket: it knows nothing, so re-assert the whole set
  useEffect(() => {
    if (!sock || !connected) return;
    for (const id of subsRef.current) sock.send({ t: "subscribe", worktreeId: id });
  }, [connected, sock]);
  // worktrees that disappeared drop out of the set
  useEffect(() => {
    const alive = new Set(rows.map((w) => w.id));
    subsRef.current = subsRef.current.filter((id) => alive.has(id));
  }, [rows]);

  useEffect(() => {
    document.title = activeRow ? `${activeRow.name} · toyon` : "toyon";
  }, [activeRow]);

  // Looking at a worktree clears the rail's unseen ring: whichever way you got here (a rail click,
  // ⌘1-9, the palette), you are looking at it now. Looking takes a moment, not an instant, so a
  // walk with ⌥↓ that passes through a row leaves its ring for later. Focus is the other condition,
  // and it is what makes the ring worth having: a turn ending while the tab sits in the background
  // must still be there when you come back, even on the worktree you happened to leave selected.
  // A row marked unread while on screen is held (`unreadHold`), or the moment would undo the mark.
  const unseen = !!active?.unseen;
  const held = useStore((s) => s.unreadHold !== null && s.unreadHold === s.activeId);
  useEffect(() => {
    if (!sock || !activeId || !unseen || held) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const looking = () => document.visibilityState === "visible" && document.hasFocus();
    const arm = () => {
      clearTimeout(timer);
      if (!looking()) return;
      // arriving is what a recap waits for: this tab keeps the line from here, before the ring clears
      dispatch({ a: "arrive", id: activeId });
      timer = setTimeout(() => {
        if (looking()) sock.send({ t: "seen", worktreeId: activeId });
      }, SEEN_AFTER_MS);
    };
    const disarm = () => clearTimeout(timer);
    arm();
    window.addEventListener("focus", arm);
    window.addEventListener("blur", disarm);
    return () => {
      disarm();
      window.removeEventListener("focus", arm);
      window.removeEventListener("blur", disarm);
    };
  }, [sock, activeId, unseen, held, dispatch]);

  // Files edited in another app while this window was behind it are news the rail cannot hear on
  // its own: its counts move on toyon's events. Coming back recounts the project's rows and re-reads
  // its open changes lists, at most once every few seconds, since a focus bounce through a dialog is
  // not a trip away.
  const recountedAt = useRef(0);
  useEffect(() => {
    if (!sock || !connected || !activeRepoId) return;
    const onFocus = () => {
      if (Date.now() - recountedAt.current < RECOUNT_AFTER_MS) return;
      recountedAt.current = Date.now();
      sock.send({ t: "refresh-git", repoId: activeRepoId });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [sock, connected, activeRepoId]);

  // paint the selected theme (or the picker's live preview); previews get the accent for their overlays
  useEffect(() => {
    // a picker preview paints but is not remembered: a crash mid-browse must not adopt it
    applyTheme(theme, { remember: !previewing });
    previewBus.broadcast(bridgeThemeMsg(theme));
  }, [theme, previewing]);
  useEffect(() => onPrefersDarkChange((v) => dispatch({ a: "system-dark", v })), [dispatch]);

  useEffect(() => {
    if (!activeId) return;
    try {
      localStorage.setItem(STORAGE.active, activeId);
    } catch {}
  }, [activeId]);
  useEffect(() => {
    if (!activeRepoId) return;
    try {
      localStorage.setItem(STORAGE.repo, activeRepoId);
    } catch {}
  }, [activeRepoId]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.rail, railOpen ? "1" : "0");
    } catch {}
  }, [railOpen]);
  // the panel layout is per project: a reload comes back to the one this project was left in
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.panels, JSON.stringify(panels));
    } catch {}
  }, [panels]);
  // and so is the selected worktree: switching projects after a reload lands where you left that
  // one, not on its main
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.lastActive, JSON.stringify(lastActive));
    } catch {}
  }, [lastActive]);
  // so is an opened discovered section: it is collapsed by default, and re-collapsing it on every
  // reload would make the one repo where you are watching stray worktrees the most annoying one
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.discoveredOpen, JSON.stringify(discoveredOpen));
    } catch {}
  }, [discoveredOpen]);
  // and so is the archived section, for the same reason
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.archivedOpen, JSON.stringify(archivedOpen));
    } catch {}
  }, [archivedOpen]);

  useChords();
  // only the chat panel attaches a dropped file, but the drag is intercepted app-wide: the
  // browser's own answer to a stray file drop is to navigate the tab to it, session and all
  useFileDrop();

  // ship results: open PR/compare URLs, auto-dismiss toasts
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    if (toast.ok && toast.url && openedRef.current !== toast.url) {
      openedRef.current = toast.url;
      window.open(toast.url, "_blank");
    }
    const timer = setTimeout(() => dispatch({ a: "dismiss-toast" }), toast.ok ? 5000 : 12000);
    return () => clearTimeout(timer);
  }, [toast, dispatch]);

  // route follows you across variant siblings: comparing the same screen is the whole point of
  // variants, so switching carries the current path over
  const prevActiveRef = useRef<string | null>(null);
  useOnChange([activeId], () => {
    const prevId = prevActiveRef.current;
    prevActiveRef.current = activeId;
    if (!prevId || !activeId || prevId === activeId) return;
    const s = store.getState();
    const prev = rows.find((w) => w.id === prevId);
    const next = rows.find((w) => w.id === activeId);
    const g = prev?.worktree?.variant?.group;
    if (!g || next?.worktree?.variant?.group !== g) return;
    const pathOf = (id: string) => {
      try {
        const u = s.local[id]?.page.url;
        return u ? new URL(u).pathname + new URL(u).search : "/";
      } catch {
        return "/";
      }
    };
    const from = pathOf(prevId);
    if (from !== pathOf(activeId)) previewBus.post(activeId, { type: "navigate", path: from });
  });

  // resizable docks, widths persisted per browser; the nav cluster stays centered over the preview
  const [leftW, setLeftW] = usePersisted(STORAGE.leftWidth, 220, (raw) => (raw ? clampW(Number(raw), 220) : undefined));
  const [rightW, setRightW] = usePersisted(STORAGE.rightWidth, 380, (raw) =>
    raw ? clampW(Number(raw), 380) : undefined,
  );
  const dragLeft = useDragResize((ev) => clampW(ev.clientX, 220), setLeftW);
  // keeping the rail open takes its width out of the row, so the docks have to know about it: the
  // chat's drag and the status bar both measure back from the window edge
  const railPx = firstRun ? 0 : railOpen ? RAIL_OPEN_PX : RAIL_PX;
  const dragRight = useDragResize((ev) => clampW(window.innerWidth - railPx - ev.clientX, 380), setRightW);

  // a right-click nothing else answered: bare chrome opens the app's own menu, so the gesture
  // works everywhere and nobody learns to stop trying it. A row that answered has stopped the
  // event already; the check on defaultPrevented is the second lock.
  const cm = useContextMenu("app");
  const appMenu = cm.contextMenu(() => appItems(store.getState(), { sock, dispatch }));

  return (
    <div
      className={cx("app", zen && "zen")}
      onContextMenu={(e) => {
        if (e.defaultPrevented || (e.target instanceof Element && e.target.closest(NATIVE_MENU))) return;
        appMenu.onContextMenu(e);
      }}
    >
      <Tooltips />
      <Menus />
      <StatusBar leftPx={leftOpen ? leftW : 0} rightPx={(rightOpen ? rightW : 0) + railPx} />
      <div className="docks">
        <LeftDock width={leftW} />
        {leftOpen && <div className="dock-resize left" onPointerDown={dragLeft} />}
        <Center />
        {rightOpen && <div className="dock-resize right" onPointerDown={dragRight} />}
        <RightDock width={rightW} />
        {!firstRun && <WtRail />}
      </div>
      {toast && (
        // shown again for each new message, which puts it over whatever has opened since
        <Float className={cx("toast", !toast.ok && "err")} role="status" raiseKey={toast}>
          {toast.message}
          <IconButton
            icon="close"
            label="Dismiss"
            tone="quiet"
            className="toast-dismiss"
            onClick={() => dispatch({ a: "dismiss-toast" })}
          />
          {toast.removeIds && toast.removeIds.length > 0 && (
            <Button
              variant="outline"
              size="md"
              tone="primary"
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation();
                removeWorktrees(sock, dispatch, toast.removeIds ?? []);
                dispatch({ a: "dismiss-toast" });
              }}
            >
              {toast.removeIds.length > 1 ? `clean up ${toast.removeIds.length} worktrees` : "remove worktree"}
            </Button>
          )}
          {toast.restoreId && (
            <Button
              variant="outline"
              size="md"
              tone="primary"
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation();
                if (toast.restoreId) restoreArchived(sock, toast.restoreId, clientId);
                dispatch({ a: "dismiss-toast" });
              }}
            >
              restore
            </Button>
          )}
        </Float>
      )}
    </div>
  );
}
