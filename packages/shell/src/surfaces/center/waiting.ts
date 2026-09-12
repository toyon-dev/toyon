import type { ConnectFailure } from "@toyon/shared";

/**
 * What the centre says when it has nothing of theirs to show and no view of its own is standing in.
 *
 * These sentences were a five-deep ternary inside the markup, which is why none of them had ever
 * been tested: they are the only user interface the shell has while the daemon is down, so a normal
 * dev loop never shows them to anyone. A pure function is what the rail walk and the recap already
 * do with a choice like this.
 *
 * Order matters and is the whole logic. The socket being down wins over everything, because nothing
 * further is known. Then having no project at all. Then the two things a project that is still
 * arriving can be: building, or empty and waiting to be told what to build.
 */

/** what to say while the socket is down, by what ws.ts worked out about why */
const CONNECT: Record<ConnectFailure | "probing", string> = {
  probing: "connecting to daemon…",
  down: "the daemon is not running.\nrun `toyon` in your repo to start it; `toyon doctor` says what it can see",
  blocked:
    "the daemon is up, but this page's websocket never connected.\na proxy, VPN or browser extension is the usual cause; `toyon doctor` checks from the terminal",
  unauthorized: "this page's token is not the running daemon's.\nrun `toyon` again and open the link it prints",
};

const NO_TOKEN =
  "no access token for this address.\nrun `toyon` in your repo, or open the full URL\n(with #token=…) printed in ~/.toyon/daemon.log";

export type Waiting = {
  connected: boolean;
  /** the bootstrap fetch answered, so the daemon is up and the socket is a moment away */
  heard: boolean;
  connectFailure: ConnectFailure | null;
  hasToken: boolean;
  /** the chord that opens a project, spelled for this platform */
  projectChord: string;
  /** the active worktree's title, or null when nothing is open */
  title: string | null;
  needsSetup: boolean;
  busy: boolean;
  treeEmpty: boolean;
};

/** the sentence, or null when a view of its own (boot, no preview) should stand here instead */
export function waitingText(w: Waiting): string | null {
  if (!w.connected && (!w.heard || w.connectFailure)) {
    return w.hasToken ? (CONNECT[w.connectFailure ?? "probing"] ?? CONNECT.probing) : NO_TOKEN;
  }
  // before hello there is nothing to say: the rows are about to arrive and a sentence would flash
  if (w.title === null) {
    return w.heard
      ? `nothing open yet.\npress ${w.projectChord} to open a project, or type a name there to start a new one`
      : "";
  }
  if (w.needsSetup && w.busy) return `building in ${w.title}; the preview appears once it starts`;
  if (w.needsSetup && w.treeEmpty) return `${w.title} is empty so far; say what to build`;
  return null;
}
