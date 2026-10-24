import type { Screen } from "../../state/store.ts";

/**
 * Which screen the phone's one column draws under the bar.
 *
 * This was a ternary chain in the markup, and the screen that matters most had a hole in it: a
 * daemon speaking another protocol than this page got its card only when it was another machine's.
 * For the machine that served the page the chain fell through to the connection sentence, which
 * with the daemon answering over HTTP reads as nothing being open, and no bar chip is mounted on a
 * phone to offer the restart. The card is the phone's one way to ask for it.
 *
 * Order is the logic. A protocol the page cannot read wins over everything, since nothing further
 * can be known off that socket. Then the socket being down, or nothing open, said in a sentence.
 * Then the list, while no worktree is on screen. Then a file opened over whichever tab is open, and
 * last the tab itself.
 */
export type PhoneScreen =
  /** the daemon was updated under this page; `foreign` names another machine, null is this one */
  | { kind: "updated"; foreign: string | null }
  | { kind: "say" }
  | { kind: "home" }
  | { kind: "editor" }
  | { kind: "tab"; tab: Screen };

export interface PhoneState {
  /** the daemon speaks another protocol than this page */
  incompatible: boolean;
  /** the machine on screen is the one that served the page */
  serving: boolean;
  /** the machine on screen, as the switcher names it */
  machine: string;
  /** the connection has a sentence to say */
  said: boolean;
  /** a worktree is on screen, or a page for one that went */
  onWorktree: boolean;
  /** a file is open over the tab */
  editor: boolean;
  tab: Screen;
}

export function phoneScreen(s: PhoneState): PhoneScreen {
  if (s.incompatible) return { kind: "updated", foreign: s.serving ? null : s.machine };
  if (s.said) return { kind: "say" };
  if (!s.onWorktree) return { kind: "home" };
  if (s.editor) return { kind: "editor" };
  return { kind: "tab", tab: s.tab };
}
