import { useCallback, useEffect, useRef, useState } from "react";
import { appItems } from "../state/actions/app.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../state/context.tsx";
import { STORAGE } from "../state/keys.ts";
import {
  useActive,
  useActiveId,
  useActiveRow,
  useArchivedPage,
  useChatCentred,
  useFirstRun,
  useRows,
  useTheme,
} from "../state/selectors.ts";
import { Center } from "../surfaces/center/Center.tsx";
import { ChangesDock } from "../surfaces/changes/ChangesDock.tsx";
import { ChatDock } from "../surfaces/chat/ChatDock.tsx";
import { useFileDrop } from "../surfaces/chat/useIntake.ts";
import { Rail } from "../surfaces/rail/Rail.tsx";
import { TopBar } from "../surfaces/topbar/TopBar.tsx";
import { clampW } from "../surfaces/util.ts";
import { applyTheme, bridgeThemeMsg, onPrefersDarkChange, rememberDaylight } from "../theme.ts";
import { floats } from "../ui/floats.ts";
import { useDragResize, useOnChange, usePersisted } from "../ui/hooks.ts";
import { Menus } from "../ui/Menu.tsx";
import { useContextMenu } from "../ui/menu.ts";
import { Tooltips } from "../ui/Tooltip.tsx";
import { type DockSide, dockWidthAt } from "./dockWidth.ts";
import { useChords } from "./keys.ts";
import { previewBus } from "./previewBus.ts";
import "./app.css";
import { cx } from "../ui/cx.ts";

const MRU_SUBSCRIPTIONS = 3;
/** how long a worktree stays on screen, with the window focused, before its unseen ring clears */
const SEEN_AFTER_MS = 2000;
/** how long the active worktree stays put before the daemon is told this tab is looking at it:
 * the same idea as `SEEN_AFTER_MS`, shorter because it only has to skip the rows a keyboard walk
 * passes through, each of which would otherwise boot a dev server */
const VIEW_AFTER_MS = 200;
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
  const daylight = useStore((s) => s.daylight);
  const daylightUntil = useStore((s) => s.daylight?.until ?? 0);
  const firstRun = useFirstRun();
  // a project with nothing to run has the chat as its centre: no dock beside it, and no page for
  // zen to give the window to (a zen left on by another project waits for that one)
  const chatCentred = useChatCentred();
  const zen = useStore((s) => s.zen) && !chatCentred;
  // both docks are hidden, not closed, on the new-project view and while the composer sits in the
  // centre of an empty project. So is the rail: on the page it lists a project that is not the one
  // being made, and on an empty project its only row is main, already open, with no new worktree to
  // offer, since one off the root commit would take the scaffold to a branch while main stayed blank.
  // The chat dock is hidden on an archived worktree's page too, whose chat is the page itself; the
  // changes dock stays, showing that worktree's work rather than the row's underneath.
  const archivedPage = useArchivedPage();
  const changesOpen = useStore((s) => s.layout.changes) && !firstRun;
  const chatOpen = useStore((s) => s.layout.chat) && !firstRun && !chatCentred && !archivedPage;
  const railOpen = useStore((s) => s.railOpen);
  const chatSide = useStore((s) => s.chatSide);
  const layouts = useStore((s) => s.layouts);
  const lastActive = useStore((s) => s.lastActive);
  const discoveredOpen = useStore((s) => s.discoveredOpen);
  const archivedOpen = useStore((s) => s.archivedOpen);
  const theme = useTheme();
  const previewing = useStore((s) => s.previewTheme !== null);
  const openUrl = useStore((s) => s.openUrl);
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
  // Looking is what keeps a worktree's dev servers running, and what wakes them: the daemon hears
  // which worktree this tab shows, and none while the tab is hidden. A subscription is not a look
  // (the last few rows stay subscribed so their streams are warm), and a look at a new row waits a
  // moment, so a walk through the rail does not boot a server per row passed. A hidden tab, and a
  // new socket, say so at once. Hidden worktrees still reload after a turn: the turn's hold keeps
  // an awake one up, and an asleep one has no frame to reload.
  const viewedRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!sock || !connected) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tell = () => {
      const id = document.visibilityState === "visible" ? activeId : null;
      sock.send({ t: "view", worktreeId: id });
      viewedRef.current = id;
    };
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(tell, VIEW_AFTER_MS);
    };
    if (viewedRef.current === undefined || viewedRef.current === activeId || document.visibilityState !== "visible") {
      tell();
    } else {
      settle();
    }
    const onVisibility = () => (document.visibilityState === "visible" ? settle() : tell());
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeId, connected, sock]);
  // An archived worktree's page reads its chat over the same stream, under the id the worktree
  // comes back with. The subscription goes with the page: the page closes as the restored row is
  // listed, so the row's own subscribe above is a new one and gets the live backfill. Left in the
  // set, a restore would find itself already subscribed and get nothing.
  const archivedId = archivedPage?.id ?? null;
  useEffect(() => {
    if (!sock || !connected || !archivedId) return;
    sock.send({ t: "subscribe", worktreeId: archivedId });
    return () => sock.send({ t: "unsubscribe", worktreeId: archivedId });
  }, [archivedId, connected, sock]);
  // worktrees that disappeared drop out of the set
  useEffect(() => {
    const alive = new Set(rows.map((w) => w.id));
    subsRef.current = subsRef.current.filter((id) => alive.has(id));
  }, [rows]);

  const pageName = archivedPage?.title ?? activeRow?.name ?? null;
  useEffect(() => {
    document.title = pageName ? `${pageName} · Toyon` : "Toyon";
  }, [pageName]);

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

  // Where the sun is has no media query behind it: the zone table lives in the daemon, so the shell
  // asks. It asks for every mode, not only the one that follows daylight, because the picker's row
  // says which way it is leaning before you choose it.
  const askZone = useCallback(() => {
    sock?.send({ t: "zone", tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  }, [sock]);
  useEffect(() => {
    if (!connected) return;
    askZone();
    // a laptop shut at midnight fires its timeout whenever it wakes, which is the wrong minute and
    // possibly the wrong day; coming back to the tab is the signal that can be trusted
    const wake = () => {
      if (document.visibilityState === "visible") askZone();
    };
    document.addEventListener("visibilitychange", wake);
    return () => document.removeEventListener("visibilitychange", wake);
  }, [connected, askZone]);
  useEffect(() => {
    if (!connected || daylightUntil <= Date.now()) return;
    // a second past it, so the daemon is answering about the side we have crossed onto
    const timer = setTimeout(askZone, daylightUntil - Date.now() + 1000);
    return () => clearTimeout(timer);
  }, [connected, daylightUntil, askZone]);
  // carried forward so tomorrow's first paint knows which side of the boundary it is on
  useEffect(() => {
    if (daylight && daylight.until > 0) rememberDaylight(daylight);
  }, [daylight]);

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
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.chatSide, chatSide);
    } catch {}
  }, [chatSide]);
  // the panel layout is per project: a reload comes back to the one this project was left in
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.layouts, JSON.stringify(layouts));
    } catch {}
  }, [layouts]);
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

  // the page a land opened (its PR), once: the ref keeps a re-run of the effect from opening it twice
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!openUrl || openedRef.current === openUrl) return;
    openedRef.current = openUrl;
    window.open(openUrl, "_blank");
    dispatch({ a: "opened-url" });
  }, [openUrl, dispatch]);

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

  // resizable docks, widths persisted per browser. A handle's class says which side of it its dock
  // stands, for the grab strip (app.css) and this measure alike, and the width set is the pointer's
  // distance from the dock's far edge, so either hand of the row measures the same way; the row's
  // fit to the window is the docks' CSS (app.css)
  const [changesW, setChangesW] = usePersisted(STORAGE.changesWidth, 220, (raw) =>
    raw ? clampW(Number(raw), 220) : undefined,
  );
  const [chatW, setChatW] = usePersisted(STORAGE.chatWidth, 380, (raw) => (raw ? clampW(Number(raw), 380) : undefined));
  const measure = (ev: PointerEvent, handle: HTMLElement, fallback: number) => {
    const side: DockSide = handle.classList.contains("left") ? "left" : "right";
    const dock = side === "left" ? handle.previousElementSibling : handle.nextElementSibling;
    return dock ? clampW(dockWidthAt(dock.getBoundingClientRect(), side, ev.clientX), fallback) : null;
  };
  const dragChanges = useDragResize((ev, handle) => measure(ev, handle, 220), setChangesW);
  const dragChat = useDragResize((ev, handle) => measure(ev, handle, 380), setChatW);
  // the centre column's element, for the top bar: its cluster sits over the preview
  const [centerEl, setCenterEl] = useState<HTMLDivElement | null>(null);

  // a right-click nothing else answered: bare chrome opens the app's own menu, so the gesture
  // works everywhere and nobody learns to stop trying it. A row that answered has stopped the
  // event already; the check on defaultPrevented is the second lock.
  const cm = useContextMenu("app");
  const appMenu = cm.contextMenu(() => appItems(store.getState(), { sock, dispatch }));

  // the row in either hand. DOM order is the visual order: the drag measure walks siblings and the
  // rail's peek covers the dock beside it, so nothing here may reorder by CSS. The first handle's
  // dock is before it and the second's after it, whichever dock that is.
  const changes = <ChangesDock width={changesW} />;
  // the centre shows the chat instead, and one composer at a time is the only kind there is; an
  // archived chat in the centre is the one chat panel too: a second composer, hidden, would answer
  // the focus chord and take a dropped file's bounds
  const chat = !chatCentred && !archivedPage && <ChatDock width={chatW} />;
  const rail = !firstRun && <Rail />;
  const chatLeft = chatSide === "left";
  const first = chatLeft
    ? { dock: chat, open: chatOpen, drag: dragChat }
    : { dock: changes, open: changesOpen, drag: dragChanges };
  const last = chatLeft
    ? { dock: changes, open: changesOpen, drag: dragChanges }
    : { dock: chat, open: chatOpen, drag: dragChat };

  return (
    <div
      className={cx("app", zen && "zen")}
      data-chat-side={chatSide}
      onContextMenu={(e) => {
        if (e.defaultPrevented || (e.target instanceof Element && e.target.closest(NATIVE_MENU))) return;
        appMenu.onContextMenu(e);
      }}
    >
      <Tooltips />
      <Menus />
      <TopBar center={centerEl} />
      <div className="docks">
        {chatLeft && rail}
        {first.dock}
        {first.open && <div className="dock-resize left" onPointerDown={first.drag} />}
        <Center onRoot={setCenterEl} />
        {last.open && <div className="dock-resize right" onPointerDown={last.drag} />}
        {last.dock}
        {!chatLeft && rail}
      </div>
    </div>
  );
}
