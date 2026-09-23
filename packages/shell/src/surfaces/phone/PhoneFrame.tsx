import { useDispatch, useStore } from "../../state/context.tsx";
import { useActive, useArchivedPage, useChatCentred, useTouch } from "../../state/selectors.ts";
import type { Screen } from "../../state/store.ts";
import { IconButton } from "../../ui/Button.tsx";
import { Menus } from "../../ui/Menu.tsx";
import { type TabItem, Tabs } from "../../ui/Tabs.tsx";
import { Tooltips } from "../../ui/Tooltip.tsx";
import { View } from "../../ui/View.tsx";
import { hasToken } from "../../ws.ts";
import { connectionText } from "../center/waiting.ts";
import { ChangesDock } from "../changes/ChangesDock.tsx";
import { ChatPanel } from "../chat/ChatPanel.tsx";
import { EditorPane } from "../editor/EditorPane.tsx";
import { Overlays } from "../overlays/Overlays.tsx";
import { Rail } from "../rail/Rail.tsx";
import { chord, previewUrl } from "../util.ts";
import { PhoneBar } from "./PhoneBar.tsx";
import { PhonePreview } from "./PhonePreview.tsx";
import "./phone.css";

/** read once at load (the token arrives in the URL fragment); calling it during render would write storage */
const HAS_TOKEN = hasToken();

/**
 * The shell on a phone. It controls the agents and never sets a project up, imports or makes one:
 * those happen where the daemon is, and none of the centre's own views mount here.
 *
 * One screen at a time: the list, or a worktree with three tabs under the bar and a diff over any
 * of them. The same components as the desk, at the tier this frame's root swaps in (phone.css), so
 * the frame and its tier cannot disagree. What the centre would otherwise bring, this frame owes
 * instead: the menus and tips, the overlays, and a sentence for when there is nothing to show,
 * which matters here because a phone drops its connection every time it goes in a pocket.
 */
export function PhoneFrame() {
  const dispatch = useDispatch();
  const screen = useStore((s) => s.screen);
  const active = useActive();
  const archivedPage = useArchivedPage();
  const editor = useStore((s) => s.editor);
  const remote = useStore((s) => s.remote);
  const chatCentred = useChatCentred();
  const connected = useStore((s) => s.connected);
  const heard = useStore((s) => s.heard);
  const connectFailure = useStore((s) => s.connectFailure);
  // the rail is mirrored by the hand the chat stands on, which is the only thing the attribute
  // reaches here: the docks it also turns are the desk's and are not mounted
  const chatSide = useStore((s) => s.chatSide);
  const touch = useTouch();

  // the socket being down wins over everything, and having no project at all comes next: the same
  // two sentences the centre says, and the only two of its that are not about a preview
  const say = connectionText({
    connected,
    heard,
    connectFailure,
    hasToken: HAS_TOKEN,
    projectChord: chord("project"),
    title: active?.worktree.title ?? null,
  });

  // a row that went while its screen was open (archived from the desk, or removed) leaves the
  // screen pointing at nothing; the list is where that lands
  const onWorktree = screen !== "home" && (active !== null || archivedPage !== null);
  // the app is the worktree's own, running: a project with nothing to run has no app, and an
  // archived worktree's page is about work that no longer runs
  const previewed = onWorktree && !chatCentred && !archivedPage ? active : null;
  const url = previewed ? previewUrl(previewed.worktree.id, previewed.worktree.proxyPort, remote) : null;
  // the tab under the strip's mark: a preview the row has none of falls back to its chat
  const tab: Screen = screen === "preview" && !previewed ? "chat" : screen;

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
                onClick={() => window.open(url, "_blank")}
              />
            ),
          },
        ]
      : []),
    // the explorer, the diff and the history together, which is the code; the count stays on the
    // changes tab inside it, where it names what it counts
    { id: "changes", label: "code" },
  ];

  return (
    <div
      className="app phone"
      data-chat-side={chatSide}
      data-touch={touch || undefined}
      data-hover={!touch || undefined}
    >
      <Tooltips />
      <Menus />
      <PhoneBar
        screen={onWorktree ? "chat" : "home"}
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
          {say !== null ? (
            <View wide>
              <p className="status-line">{say}</p>
            </View>
          ) : !onWorktree ? (
            <Rail placement="screen" />
          ) : editor ? (
            // a file opened from the changes list or from a tool row in the chat: the diff over
            // whichever tab is open; its close returns there, and a tab or the way back shuts it
            <EditorPane editor={editor} placement="screen" />
          ) : tab === "chat" ? (
            <ChatPanel placement="screen" archived={archivedPage} />
          ) : tab === "changes" ? (
            <ChangesDock placement="screen" />
          ) : null}
          {/* mounted for as long as this worktree is on screen, whichever tab is open, and keyed
              to it: the app is not loaded again for a tab switch, and not kept for another row */}
          {previewed && url && (
            <PhonePreview
              key={previewed.worktree.id}
              active={previewed}
              url={url}
              hidden={tab !== "preview" || editor !== null}
            />
          )}
          <Overlays />
        </div>
      </div>
    </div>
  );
}
