import { isLoopbackHost } from "@toyon/shared";
import type { MenuItem } from "../../ui/menu.ts";
import type { DaemonSocket } from "../../ws.ts";

/** The page is open on the machine the daemon runs on. A Finder reveal opens on the daemon's
 * screen, so from another device it can do nothing. `hostname` is the daemon's, as its socket
 * names it: a file on another machine listed by this page is never on this disk, whatever
 * address the page itself was opened at. */
export function openedOnDaemonMachine(hostname: string): boolean {
  return isLoopbackHost(hostname);
}

/** the host the daemon a menu is about answers at; with no socket (a test) the page's own, which
 * is where a test's daemon would be, and loopback where there is no page either */
export function daemonHost(sock: Pick<DaemonSocket, "urls"> | null | undefined): string {
  return sock?.urls.host ?? (typeof location === "object" ? location.hostname : "127.0.0.1");
}

/** the Finder reveal, for anything that is on disk: a file opens in Toyon's own pane, so the one
 * way out offered is to where it sits. None when the page was opened from another device. */
export function revealItems(onReveal: (() => void) | undefined, hostname: string): MenuItem[] {
  if (!onReveal || !openedOnDaemonMachine(hostname)) return [];
  return [{ id: "reveal", label: "reveal in Finder", onClick: onReveal }];
}
