import { useRef, useState } from "react";
import { useDispatch, useMachine, useMachines, useStore, useUrls } from "../../state/context.tsx";
import { openPreview, previewsGated } from "../../state/previewGrant.ts";
import { useActive, useArchivedPage, useChatCentred, useFoundPage, useTouch } from "../../state/selectors.ts";
import type { Screen } from "../../state/store.ts";
import { IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { useVisibleHeight, useZoomMark } from "../../ui/hooks.ts";
import { Menus } from "../../ui/Menu.tsx";
import { useSwipe } from "../../ui/swipe.ts";
import { type TabItem, Tabs } from "../../ui/Tabs.tsx";
import { Tooltips } from "../../ui/Tooltip.tsx";
import { View } from "../../ui/View.tsx";
import { hasToken } from "../../ws.ts";
import { UpdatedCard } from "../center/UpdatedCard.tsx";
import { connectionText } from "../center/waiting.ts";
import { ChangesDock } from "../changes/ChangesDock.tsx";
import { ChatPanel } from "../chat/ChatPanel.tsx";
import { EditorPane } from "../editor/EditorPane.tsx";
import { Overlays } from "../overlays/Overlays.tsx";
import { Rail } from "../rail/Rail.tsx";
import { chord, previewUrl } from "../util.ts";
import { FACES, sideOf, swipeTo } from "./faces.ts";
import { PhoneBar } from "./PhoneBar.tsx";
import { PhonePreview } from "./PhonePreview.tsx";
import { phoneScreen } from "./screen.ts";
import "./phone.css";

/** read once at load (the token arrives in the URL fragment); calling it during render would write storage */
const HAS_TOKEN = hasToken();

/**
 * The shell on a phone. It controls the agents and never sets a project up, imports or makes one:
 * those happen where the daemon is, and none of the centre's own views mount here.
 *
 * One screen at a time: the list, or a worktree with three faces under the bar and a diff over any
 * of them. The same components as the desk, at the tier this frame's root swaps in (phone.css), so
 * the frame and its tier cannot disagree. What the centre would otherwise bring, this frame owes
 * instead: the menus and tips, the overlays, and a sentence for when there is nothing to show,
 * which matters here because a phone drops its connection every time it goes in a pocket.
 *
 * The screens stand in a line (faces.ts), and a finger slides between them (useSwipe): for the
 * length of a drag the neighbour it is pulling in is mounted beside the screen, and letting go
 * makes it the screen or takes it away again. Each screen has a slot of its own, keyed and in a
 * fixed order, so a slot mounts or unmounts and no screen's node is ever moved: a moved iframe
 * reloads, and a moved list loses its scroll.
 */
export function PhoneFrame() {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  useZoomMark(rootRef);
  // the palette's list is bounded by this, so it ends above the keyboard rather than under it
  useVisibleHeight(rootRef);
  const dispatch = useDispatch();
  const screen = useStore((s) => s.screen);
  const active = useActive();
  const archivedPage = useArchivedPage();
  const foundPage = useFoundPage();
  const editor = useStore((s) => s.editor);
  const remote = useStore((s) => s.remote);
  const chatCentred = useChatCentred();
  const connected = useStore((s) => s.connected);
  const heard = useStore((s) => s.heard);
  // what the screen had stands through a drop: a phone in a pocket loses its socket often, and
  // the rows it had are worth more than a sentence about the socket
  const standing = useStore((s) => s.recalledAt !== null || s.heard);
  const connectFailure = useStore((s) => s.connectFailure);
  const touch = useTouch();
  const machine = useMachine();
  const machines = useMachines();
  /** the neighbour mounted beside the screen for the length of a drag */
  const [aside, setAside] = useState<Screen | null>(null);

  // the socket being down wins over everything, and having no project at all comes next: the same
  // two sentences the centre says, and the only two of its that are not about a preview
  const incompatible = useStore((s) => s.incompatible);
  const say = connectionText({
    connected,
    heard,
    standing,
    connectFailure,
    // another machine's token came with its pairing, so a page listing it always has one
    hasToken: machine.serving ? HAS_TOKEN : true,
    projectChord: chord("project"),
    title: active?.worktree.title ?? null,
    machine: machine.serving ? null : machines.displayName(machine.origin),
  });

  // a row that went while its screen was open (archived from the desk, or removed) leaves the
  // screen pointing at nothing; the list is where that lands
  const onWorktree = screen !== "home" && (active !== null || archivedPage !== null || foundPage !== null);
  // the app is the worktree's own, running: a project with nothing to run has no app, and an
  // archived worktree's page is about work that no longer runs
  const previewed = onWorktree && !chatCentred && !archivedPage ? active : null;
  const { host } = useUrls();
  const url = previewed ? previewUrl(previewed.worktree.id, previewed.worktree.proxyPort, remote, host) : null;
  // the tab under the strip's mark: a preview the row has none of falls back to its chat
  const tab: Screen = screen === "preview" && !previewed ? "chat" : screen;
  const shown = phoneScreen({
    incompatible,
    serving: machine.serving,
    machine: machines.displayName(machine.origin),
    said: say !== null,
    onWorktree,
    editor: editor !== null,
    tab,
  });
  // the face in flow: the list, or the open tab; null under a cover (the sentence, the updated
  // card, a diff), when no face is the screen
  const face: Screen | null = shown.kind === "home" ? "home" : shown.kind === "tab" ? shown.tab : null;
  const keepPreview = previewed !== null && url !== null;

  useSwipe(rootRef, trackRef, {
    take: (_target, way) => {
      // the list, a diff, the sentence, the updated card: no swipe; and never a second neighbour
      // while one is still beside the screen (a drop-back's settle has not called onEnd yet)
      if (shown.kind !== "tab" || aside !== null) return false;
      const to = swipeTo(shown.tab, way, keepPreview);
      if (!to) return false;
      setAside(to);
      return true;
    },
    onEnd: (went) => {
      if (went && aside) dispatch({ a: "screen", to: aside });
      setAside(null);
    },
  });

  const tabs: TabItem<Screen>[] = [
    { id: "chat", label: "chat" },
    ...(previewed && url
      ? [
          {
            id: "preview" as const,
            label: "preview",
            // the one control beside the thing it opens: the app in the browser's own tab, for the
            // address bar, a reload, or a keyboard the frame cannot have
            trail: (
              <IconButton
                icon="external"
                label="Open in browser"
                tone="chrome"
                onClick={() => openPreview(machine, url, previewsGated(machine, remote))}
              />
            ),
          },
        ]
      : []),
    // the explorer, the diff and the history together, which is the code
    { id: "changes", label: "code" },
  ];

  return (
    <div
      ref={rootRef}
      className="app phone"
      // The attribute reaches one thing here, the rail's mirror, since the docks it also turns are
      // the desk's and are not mounted. A phone has no hand for the chat to stand on, so the list
      // is pinned to the mirrored shape, dot first, rather than flipping with a desk preference
      // nothing on a phone can see or set.
      data-chat-side="left"
      data-touch={touch || undefined}
      data-hover={!touch || undefined}
    >
      <Tooltips />
      <Menus />
      <PhoneBar
        screen={onWorktree ? "chat" : "home"}
        fold={tab !== "chat" || editor !== null}
        tabs={
          onWorktree &&
          say === null && (
            <Tabs<Screen>
              fill
              segmented
              owner="phone-tabs"
              label="worktree"
              items={tabs}
              current={tab}
              onPick={(to) => dispatch({ a: "screen", to })}
            />
          )
        }
      />
      {/* the desk's .docks row with one column in it, and here for the same reason (phone.css) */}
      <div className="phone-screen">
        {/* .center-root is the isolation root every overlay counts its rungs inside, so the phone's
            column is one too, and the palette opens over this screen the way it does over the desk's */}
        <div className="center-root">
          <div className="phone-track" ref={trackRef}>
            {/* what covers the faces: the updated card, the sentence, or a file opened from the
                changes list or from a tool row in the chat, the diff over whichever face is open;
                its close returns there, and a face or the way back shuts it. A slot of its own, so
                a diff opened over the app never takes the app's slot and reloads it. */}
            {face === null && (
              <div key="cover" className="phone-face">
                {shown.kind === "updated" ? (
                  // the card asks this machine's daemon for the restart itself, over HTTP, and
                  // reloads when the new one answers; for another machine it says where the
                  // update is to be done
                  <UpdatedCard foreign={shown.foreign ?? undefined} />
                ) : shown.kind === "say" && say ? (
                  <View wide>
                    <p className={cx("status-line", say.live && "live-text")}>{say.text}</p>
                  </View>
                ) : shown.kind === "editor" && editor ? (
                  <EditorPane editor={editor} placement="screen" />
                ) : null}
              </div>
            )}
            {FACES.map((f) => {
              const current = f === face;
              // a neighbour is never the face itself: the store can move under a drag (the row
              // going, a popstate from the system's edge-back), and a face marked as its own
              // neighbour would stand a full width off the screen
              const beside = f === aside && !current;
              // the app stays mounted under the worktree's other faces, and under a diff, so a
              // face switch does not load it again; it goes with the worktree
              if (!current && !beside && !(f === "preview" && keepPreview)) return null;
              return (
                <div
                  key={f}
                  className="phone-face"
                  hidden={!current && !beside}
                  data-side={beside && face ? sideOf(face, f) : undefined}
                >
                  {f === "home" ? (
                    // this machine's worktrees: the list is the home screen, and the bar says which
                    // machine and which project it is, with the other machines a tap into the
                    // switcher away
                    <Rail placement="screen" />
                  ) : f === "chat" ? (
                    <ChatPanel placement="screen" archived={archivedPage} found={foundPage} />
                  ) : f === "changes" ? (
                    <ChangesDock placement="screen" />
                  ) : previewed && url ? (
                    <PhonePreview
                      key={previewed.worktree.id}
                      gated={previewsGated(machine, remote)}
                      active={previewed}
                      url={url}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
          <Overlays />
        </div>
      </div>
    </div>
  );
}
