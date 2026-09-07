import { useEffect, useRef } from "react";
import { useDispatch, useSock, useStore, useStoreInstance } from "../state/context.tsx";
import { STORAGE } from "../state/keys.ts";
import { useActive, useActiveId, useTheme, useWorktrees } from "../state/selectors.ts";
import { LeftDock } from "../surfaces/changes/LeftDock.tsx";
import { RightDock } from "../surfaces/chat/RightDock.tsx";
import { Center } from "../surfaces/preview/Center.tsx";
import { WtRail } from "../surfaces/rail/WtRail.tsx";
import { StatusBar } from "../surfaces/statusbar/StatusBar.tsx";
import { clampW } from "../surfaces/util.ts";
import { applyTheme, bridgeThemeMsg, onPrefersDarkChange } from "../theme.ts";
import { useDragResize, usePersisted } from "../ui/hooks.ts";
import { Tooltips } from "../ui/Tooltip.tsx";
import { useChords } from "./keys.ts";
import { previewBus } from "./previewBus.ts";

const RAIL_PX = 40;
const MRU_SUBSCRIPTIONS = 3;

/** layout + app-wide effects; every surface reads its own state through selectors */
export function App() {
  const store = useStoreInstance();
  const dispatch = useDispatch();
  const sock = useSock();
  const activeId = useActiveId();
  const activeRepoId = useStore((s) => s.activeRepoId);
  const active = useActive();
  const connected = useStore((s) => s.connected);
  const zen = useStore((s) => s.zen);
  const leftOpen = useStore((s) => s.leftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const theme = useTheme();
  const previewing = useStore((s) => s.previewTheme !== null);
  const toast = useStore((s) => s.toast);
  const worktrees = useWorktrees();

  // the daemon streams only subscribed worktrees. Keep the last few visited subscribed so their
  // previews still reload after an agent turn while hidden and switching back is instant; drop
  // the oldest beyond that. A reconnect re-subscribes the whole set.
  const subsRef = useRef<string[]>([]);
  useEffect(() => {
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
    const alive = new Set(worktrees.map((w) => w.worktree.id));
    subsRef.current = subsRef.current.filter((id) => alive.has(id));
  }, [worktrees]);

  // window/app title follows the active worktree
  useEffect(() => {
    document.title = active ? `${active.worktree.title} · toyon` : "toyon";
  }, [active?.worktree.title]);

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

  useChords();

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

  return (
    <div className={`app ${zen ? "zen" : ""}`}>
      <Tooltips />
      <StatusBar leftPx={leftOpen ? leftW : 0} rightPx={(rightOpen ? rightW : 0) + RAIL_PX} />
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
