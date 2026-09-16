import { useStore } from "../../state/context.tsx";
import { useActive, useArchivedPage, useTouch } from "../../state/selectors.ts";
import { Menus } from "../../ui/Menu.tsx";
import { Tooltips } from "../../ui/Tooltip.tsx";
import { View } from "../../ui/View.tsx";
import { hasToken } from "../../ws.ts";
import { connectionText } from "../center/waiting.ts";
import { ChatPanel } from "../chat/ChatPanel.tsx";
import { Overlays } from "../overlays/Overlays.tsx";
import { Rail } from "../rail/Rail.tsx";
import { chord } from "../util.ts";
import { PhoneBar } from "./PhoneBar.tsx";
import "./phone.css";

/** read once at load (the token arrives in the URL fragment); calling it during render would write storage */
const HAS_TOKEN = hasToken();

/**
 * The shell on a phone.
 *
 * The phone runs nothing; it talks to a daemon that is on the laptop over the tailnet or on a
 * machine in the cloud. What it controls is the agents: see what is waiting, answer, read, steer,
 * stop, start a worktree from main. What it does not do is set a project up, import one or make
 * one: those happen where the daemon is. The centre's own views, the preview and the panes are the
 * desk's, and none of them mount here.
 *
 * One screen at a time, because the window is one column wide. What it holds is the rail's list or
 * a worktree's chat, both of them the same components the desk uses, at the row height and type
 * size this frame's root swaps in (phone.css): the frame and its tier are one class, and cannot
 * disagree.
 *
 * Three things the centre would otherwise have brought, which this frame owes instead:
 * the menus and tips a row opens, the overlays (the palette, which on a device with no keyboard is
 * how anything without a visible control is reached), and a sentence for when there is nothing to
 * show. That last one matters more here than on a desk: a phone drops its connection every time it
 * is put in a pocket.
 */
export function PhoneFrame() {
  const screen = useStore((s) => s.screen);
  const active = useActive();
  const archivedPage = useArchivedPage();
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

  // a row that went while its chat was open (archived from the desk, or removed) leaves the screen
  // pointing at nothing; the list is where that lands
  const onChat = screen === "chat" && (active !== null || archivedPage !== null);

  return (
    <div className="app phone" data-chat-side={chatSide} data-touch={touch || undefined}>
      <Tooltips />
      <Menus />
      <PhoneBar screen={onChat ? "chat" : "home"} />
      {/* the desk's .docks row with one column in it, and here for the same reason (phone.css) */}
      <div className="phone-screen">
        {/* .center is the isolation root every overlay counts its rungs inside, so the phone's
            column is one too, and the palette opens over this screen the way it does over the desk's */}
        <div className="center">
          {say !== null ? (
            <View wide>
              <p className="status-line">{say}</p>
            </View>
          ) : onChat ? (
            <ChatPanel placement="screen" archived={archivedPage} />
          ) : (
            <Rail placement="screen" />
          )}
          <Overlays />
        </div>
      </div>
    </div>
  );
}
