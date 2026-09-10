import { useEffect, useRef } from "react";
import { useDispatch, useSock, useStore, useStoreInstance } from "../state/context.tsx";
import { STORAGE } from "../state/keys.ts";
import { useActive, useActiveId, useActiveRow, useRows, useTheme } from "../state/selectors.ts";
import { LeftDock } from "../surfaces/changes/LeftDock.tsx";
import { RightDock } from "../surfaces/chat/RightDock.tsx";
import { useFileDrop } from "../surfaces/chat/useIntake.ts";
import { Center } from "../surfaces/preview/Center.tsx";
import { WtRail } from "../surfaces/rail/WtRail.tsx";
import { removeWorktrees } from "../surfaces/rail/worktreeActions.ts";
import { StatusBar } from "../surfaces/statusbar/StatusBar.tsx";
import { clampW } from "../surfaces/util.ts";
import { applyTheme, bridgeThemeMsg, onPrefersDarkChange } from "../theme.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { useDragResize, useOnChange, usePersisted } from "../ui/hooks.ts";
import { Tooltips } from "../ui/Tooltip.tsx";
import { useChords } from "./keys.ts";
import { previewBus } from "./previewBus.ts";
import "./app.css";
import { cx } from "../ui/cx.ts";

/** the worktree rail: the strip it keeps when it peeks, and the column it takes when kept open
 *  (both also in rail.css, as the rail's width and --rail-width) */
const RAIL_PX = 40;
const RAIL_OPEN_PX = 232;
const MRU_SUBSCRIPTIONS = 3;

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
  const leftOpen = useStore((s) => s.leftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const railOpen = useStore((s) => s.railOpen);
  const panels = useStore((s) => s.panels);
  const lastActive = useStore((s) => s.lastActive);
  const discoveredOpen = useStore((s) => s.discoveredOpen);
  const theme = useTheme();
  const previewing = useStore((s) => s.previewTheme !== null);
  const toast = useStore((s) => s.toast);
  const rows = useRows();

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

  // window/app title follows the active row
  useEffect(() => {
    document.title = activeRow ? `${activeRow.name} · toyon` : "toyon";
  }, [activeRow]);

  // Selecting a worktree clears the rail's unseen ring: whichever way you got here (a rail click,
  // ⌘1-9, the palette), you are looking at it now. Focus is the one condition kept, and it is what
  // makes the ring worth having: a turn ending while the tab sits in the background must still be
  // there when you come back, even on the worktree you happened to leave selected.
  const unseen = !!active?.unseen;
  useEffect(() => {
    if (!sock || !activeId || !unseen) return;
    const seen = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) sock.send({ t: "seen", worktreeId: activeId });
    };
    seen();
    window.addEventListener("focus", seen);
    return () => window.removeEventListener("focus", seen);
  }, [sock, activeId, unseen]);

  // paint the selected theme (or the picker's live preview); previews get the accent for their overlays
  useEffect(() => {
    // a picker preview paints but is not remembered: a crash mid-browse must not adopt it
    applyTheme(theme, { remember: !previewing });
    previewBus.broadcast(bridgeThemeMsg(theme));
  }, [theme, previewing]);
  useEffect(() => onPrefersDarkChange((v) => dispatch({ a: "system-dark", v })), [dispatch]);

  // remember the selection across reloads
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

  useChords();
  // only the chat panel attaches a dropped file, but the drag is intercepted app-wide: the
  // browser's own answer to a stray file drop is to navigate the tab to it, session and all
  useFileDrop(activeId);

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
  const railPx = railOpen ? RAIL_OPEN_PX : RAIL_PX;
  const dragRight = useDragResize((ev) => clampW(window.innerWidth - railPx - ev.clientX, 380), setRightW);

  return (
    <div className={cx("app", zen && "zen")}>
      <Tooltips />
      <StatusBar leftPx={leftOpen ? leftW : 0} rightPx={(rightOpen ? rightW : 0) + railPx} />
      <div className="docks">
        <LeftDock width={leftW} />
        {leftOpen && <div className="dock-resize left" onPointerDown={dragLeft} />}
        <Center />
        {rightOpen && <div className="dock-resize right" onPointerDown={dragRight} />}
        <RightDock width={rightW} />
        <WtRail />
      </div>
      {toast && (
        <div className={cx("toast", !toast.ok && "err")} role="status">
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
        </div>
      )}
    </div>
  );
}
