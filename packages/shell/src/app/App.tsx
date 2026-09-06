import { useCallback, useEffect, useRef } from "react";
import { type Store, useDispatch, useSock, useStore } from "../state/context.tsx";
import { STORAGE } from "../state/keys.ts";
import { useActive, useActiveId, useTheme, useWorktrees } from "../state/selectors.ts";
import { LeftDock } from "../surfaces/changes/LeftDock.tsx";
import { RightDock } from "../surfaces/chat/RightDock.tsx";
import { Center } from "../surfaces/preview/Center.tsx";
import { WtRail } from "../surfaces/rail/WtRail.tsx";
import { StatusBar } from "../surfaces/statusbar/StatusBar.tsx";
import { clampW } from "../surfaces/util.ts";
import { applyTheme, bridgeThemeMsg, onPrefersDarkChange } from "../theme.ts";
import { useDragResize, usePersisted, useWindowWidth } from "../ui/hooks.ts";
import { Tooltips } from "../ui/Tooltip.tsx";
import { useChords } from "./keys.ts";
import { previewBus } from "./previewBus.ts";

const RAIL_PX = 40;

/** layout + app-wide effects; every surface reads its own state through selectors */
export function App({ store }: { store: Store }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const activeId = useActiveId();
  const active = useActive();
  const connected = useStore((s) => s.connected);
  const zen = useStore((s) => s.zen);
  const leftOpen = useStore((s) => s.leftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const theme = useTheme();
  const toast = useStore((s) => s.toast);
  const worktrees = useWorktrees();

  // subscribe when the active worktree changes (and again after a reconnect)
  useEffect(() => {
    if (activeId && sock) sock.send({ t: "subscribe", worktreeId: activeId });
  }, [activeId, connected, sock]);

  // window/app title follows the active worktree
  useEffect(() => {
    document.title = active ? `${active.worktree.title} — orchardist` : "orchardist";
  }, [active?.worktree.title]);

  // paint the selected theme (or the picker's live preview); previews get the accent for their overlays
  useEffect(() => {
    applyTheme(theme);
    previewBus.broadcast(bridgeThemeMsg(theme));
  }, [theme]);
  useEffect(() => onPrefersDarkChange((v) => dispatch({ a: "system-dark", v })), [dispatch]);

  // remember the selection across reloads
  useEffect(() => {
    if (!activeId) return;
    try {
      localStorage.setItem(STORAGE.active, activeId);
    } catch {}
  }, [activeId]);

  const send = useCallback((m: { t: "list-files"; worktreeId: string }) => sock?.send(m), [sock]);
  useChords(store, send);

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
  useEffect(() => {
    const prevId = prevActiveRef.current;
    prevActiveRef.current = activeId;
    if (!prevId || !activeId || prevId === activeId) return;
    const s = store.getState();
    const prev = worktrees.find((w) => w.worktree.id === prevId);
    const next = worktrees.find((w) => w.worktree.id === activeId);
    const g = prev?.worktree.variant?.group;
    if (!g || next?.worktree.variant?.group !== g) return;
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
  }, [activeId]);

  // resizable docks, widths persisted per browser; the nav cluster stays centered over the preview
  const [leftW, setLeftW] = usePersisted(STORAGE.leftWidth, 220, (raw) => (raw ? clampW(Number(raw), 220) : undefined));
  const [rightW, setRightW] = usePersisted(STORAGE.rightWidth, 380, (raw) =>
    raw ? clampW(Number(raw), 380) : undefined,
  );
  const dragLeft = useDragResize((ev) => clampW(ev.clientX, 220), setLeftW);
  // the worktree rail sits between the chat dock and the window edge
  const dragRight = useDragResize((ev) => clampW(window.innerWidth - RAIL_PX - ev.clientX, 380), setRightW);
  const winW = useWindowWidth();
  const leftPx = leftOpen ? leftW : 0;
  const rightPx = (rightOpen ? rightW : 0) + RAIL_PX;
  const navCenter = leftPx + (winW - leftPx - rightPx) / 2;

  return (
    <div className={`app ${zen ? "zen" : ""}`}>
      <Tooltips />
      <StatusBar navCenter={navCenter} />
      <div className="docks">
        <LeftDock width={leftW} />
        {leftOpen && <div className="dock-resize left" onPointerDown={dragLeft} />}
        <Center />
        {rightOpen && <div className="dock-resize right" onPointerDown={dragRight} />}
        <RightDock width={rightW} />
        <WtRail />
      </div>
      {toast && (
        <div className={`toast ${toast.ok ? "ok" : "err"}`} onClick={() => dispatch({ a: "dismiss-toast" })}>
          {toast.message}
          {toast.removeIds && toast.removeIds.length > 0 && (
            <button
              className="btn btn-outline toast-action"
              onClick={(e) => {
                e.stopPropagation();
                for (const id of toast.removeIds ?? []) sock?.send({ t: "remove-worktree", worktreeId: id });
                dispatch({ a: "dismiss-toast" });
              }}
            >
              {toast.removeIds.length > 1 ? `clean up ${toast.removeIds.length} worktrees` : "remove worktree"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
