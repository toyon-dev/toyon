import { useCallback, useEffect, useRef } from "react";
import { useDispatch, useSock, useStore, useStoreInstance } from "../state/context.tsx";
import { STORAGE } from "../state/keys.ts";
import { useActive, useActiveId, useActiveRow, useArchivedPage, useRows, useTheme } from "../state/selectors.ts";
import { useFileDrop } from "../surfaces/chat/useIntake.ts";
import { PhoneFrame } from "../surfaces/phone/PhoneFrame.tsx";
import { applyTheme, bridgeThemeMsg, onPrefersDarkChange, rememberDaylight } from "../theme.ts";
import { floats } from "../ui/floats.ts";
import { useOnChange } from "../ui/hooks.ts";
import { DeskFrame } from "./DeskFrame.tsx";
import { useChords } from "./keys.ts";
import { previewBus } from "./previewBus.ts";
import "./app.css";

const MRU_SUBSCRIPTIONS = 3;
/** how long a worktree stays on screen, with the window focused, before its unseen ring clears */
const SEEN_AFTER_MS = 2000;
/** how long the active worktree stays put before the daemon is told this tab is looking at it:
 * the same idea as `SEEN_AFTER_MS`, shorter because it only has to skip the rows a keyboard walk
 * passes through, each of which would otherwise boot a dev server */
const VIEW_AFTER_MS = 200;
/** the least time between recounts on coming back to the window */
const RECOUNT_AFTER_MS = 5000;

/** the app-wide effects, and which frame draws the window; every surface reads its own state
 * through selectors, and each frame the layout state only it uses */
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
  const archivedPage = useArchivedPage();
  const railOpen = useStore((s) => s.railOpen);
  const chatSide = useStore((s) => s.chatSide);
  const layouts = useStore((s) => s.layouts);
  const lastActive = useStore((s) => s.lastActive);
  const discoveredOpen = useStore((s) => s.discoveredOpen);
  const archivedOpen = useStore((s) => s.archivedOpen);
  const treeOpen = useStore((s) => s.treeOpen);
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
  // Worktrees that disappeared drop out of the set, and the daemon hears it: its set is per socket
  // and outlives the worktree, so an archived one this tab had looked at would still count as
  // subscribed there, and the subscribe its archived page sends under the same id would be taken
  // for a repeat and get no backfill, leaving the page's chat empty until it was left and reopened.
  useEffect(() => {
    const alive = new Set(rows.map((w) => w.id));
    const gone = subsRef.current.filter((id) => !alive.has(id));
    if (gone.length === 0) return;
    subsRef.current = subsRef.current.filter((id) => alive.has(id));
    if (!sock || !connected) return;
    for (const id of gone) sock.send({ t: "unsubscribe", worktreeId: id });
  }, [rows, connected, sock]);

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
  }, [sock, activeId, unseen, held]);

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
  // the folders opened by hand in each files tab: a reload comes back to the tree as it was left
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.treeOpen, JSON.stringify(treeOpen));
    } catch {}
  }, [treeOpen]);

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

  // The frame, decided in app/phone.ts and read here. Two of them, because the phone's is not the
  // desk's with rules turned off: the docks measure siblings, the rail's peek is an overlay sized
  // to the row it covers, and the centre holds a live iframe per worktree visited. None of that
  // reflows into one column. Each frame keeps the state only it uses, so neither pays for the other.
  const frame = useStore((s) => s.frame);
  return frame === "phone" ? <PhoneFrame /> : <DeskFrame />;
}
