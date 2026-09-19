import { useState } from "react";
import { appItems } from "../state/actions/app.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../state/context.tsx";
import { STORAGE } from "../state/keys.ts";
import { useArchivedPage, useBare, useChatCentred, useTouch } from "../state/selectors.ts";
import { Center } from "../surfaces/center/Center.tsx";
import { ChangesDock } from "../surfaces/changes/ChangesDock.tsx";
import { ChatDock } from "../surfaces/chat/ChatDock.tsx";
import { Rail } from "../surfaces/rail/Rail.tsx";
import { TopBar } from "../surfaces/topbar/TopBar.tsx";
import { clampW } from "../surfaces/util.ts";
import { cx } from "../ui/cx.ts";
import { useDragResize, usePersisted } from "../ui/hooks.ts";
import { Menus } from "../ui/Menu.tsx";
import { useContextMenu } from "../ui/menu.ts";
import { Tooltips } from "../ui/Tooltip.tsx";
import { type DockSide, dockWidthAt } from "./dockWidth.ts";

/** Where the browser's own menu is the useful one and ours would take it away: anything typed
 * into (spelling, paste), the terminal (paste), Monaco, and the preview, which is the person's
 * site and not our chrome. Everything else on the page answers with the app menu. */
const NATIVE_MENU = "input, textarea, [contenteditable], .monaco-editor, .xterm, iframe";

/**
 * The workbench: the row of docks around the centre, on a screen with a pointer and a keyboard.
 *
 * A frame of its own rather than a branch inside App because hooks cannot be conditional, and
 * everything here is the desk's alone: two persisted dock widths, two drag measures that walk the
 * DOM, and the centre element the top bar places its cluster over. Held in one component, none of
 * it runs on a phone.
 */
export function DeskFrame() {
  const store = useStoreInstance();
  const dispatch = useDispatch();
  const sock = useSock();
  const bare = useBare();
  const touch = useTouch();
  // a project with nothing to run has the chat as its centre: no dock beside it, and no page for
  // zen to give the window to (a zen left on by another project waits for that one)
  const chatCentred = useChatCentred();
  const zen = useStore((s) => s.zen) && !chatCentred;
  // both docks are hidden, not closed, on the new-project view and while the composer sits in the
  // centre of an empty project. So is the rail: on the page it lists a project that is not the one
  // being made, and on an empty project its only row is main, already open, with no new worktree to
  // offer, since one off the root commit would take the scaffold to a branch while main stayed blank.
  // All three go as well on a page its daemon cannot talk to, where they have nothing to show and
  // the card in the centre lists the chats itself.
  // The chat dock is hidden on an archived worktree's page too, whose chat is the page itself; the
  // changes dock stays, showing that worktree's work rather than the row's underneath.
  const archivedPage = useArchivedPage();
  const changesOpen = useStore((s) => s.layout.changes) && !bare;
  const chatOpen = useStore((s) => s.layout.chat) && !bare && !chatCentred && !archivedPage;
  const chatSide = useStore((s) => s.chatSide);
  const railOpen = useStore((s) => s.railOpen);

  // resizable docks, widths persisted per browser. A handle's class says which side of it its dock
  // stands, for the grab strip (app.css) and this measure alike, and the width set is the pointer's
  // distance from the dock's far edge, so either hand of the row measures the same way; the row's
  // fit to the window is the docks' CSS (app.css)
  const [changesW, setChangesW] = usePersisted(STORAGE.changesWidth, 220, (raw) =>
    raw ? clampW(Number(raw), 220) : undefined,
  );
  const [chatW, setChatW] = usePersisted(STORAGE.chatWidth, 380, (raw) => (raw ? clampW(Number(raw), 380) : undefined));
  // the rail's, while it is kept open: 280 is where a sixteen-letter branch name fits with its
  // control column and all three count columns drawn
  const [railW, setRailW] = usePersisted(STORAGE.railWidth, 280, (raw) => (raw ? clampW(Number(raw), 280) : undefined));
  const measure = (ev: PointerEvent, handle: HTMLElement, fallback: number) => {
    const side: DockSide = handle.classList.contains("left") ? "left" : "right";
    const dock = side === "left" ? handle.previousElementSibling : handle.nextElementSibling;
    return dock ? clampW(dockWidthAt(dock.getBoundingClientRect(), side, ev.clientX), fallback) : null;
  };
  const dragChanges = useDragResize((ev, handle) => measure(ev, handle, 220), setChangesW);
  const dragChat = useDragResize((ev, handle) => measure(ev, handle, 380), setChatW);
  const dragRail = useDragResize((ev, handle) => measure(ev, handle, 280), setRailW);
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
  const rail = !bare && <Rail width={railW} />;
  // its handle only while it is a column: the strip peeks over the dock beside it, and a peek is
  // not resized
  const railHandle = (side: DockSide) =>
    !bare && railOpen && <div className={`dock-resize ${side}`} onPointerDown={dragRail} />;
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
      // present while the window has no hover: the stylesheets that show something on hover key
      // a tap's route to it on this, on either frame
      data-touch={touch || undefined}
      // its opposite, which every :hover rule is gated on (base.css says why)
      data-hover={!touch || undefined}
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
        {chatLeft && railHandle("left")}
        {first.dock}
        {first.open && <div className="dock-resize left" onPointerDown={first.drag} />}
        <Center onRoot={setCenterEl} />
        {last.open && <div className="dock-resize right" onPointerDown={last.drag} />}
        {last.dock}
        {!chatLeft && railHandle("right")}
        {!chatLeft && rail}
      </div>
    </div>
  );
}
