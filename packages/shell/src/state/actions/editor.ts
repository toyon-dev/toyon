import { isLoopbackHost } from "@toyon/shared";
import type { MenuItem } from "../../ui/menu.ts";
import type { DaemonSocket } from "../../ws.ts";

const EDITORS: Array<{ label: string; scheme: string }> = [
  { label: "Zed", scheme: "zed" },
  { label: "VS Code", scheme: "vscode" },
  { label: "Cursor", scheme: "cursor" },
];

/** The page is open on the machine the daemon runs on. An editor link opens the editor wherever the
 * browser is, naming a path on the daemon's disk, and a Finder reveal opens on the daemon's screen,
 * so from another device neither can do anything. `hostname` is the daemon's, as its socket names
 * it: a file on another machine listed by this page is never on this disk, whatever address the
 * page itself was opened at. */
export function openedOnDaemonMachine(hostname: string): boolean {
  return isLoopbackHost(hostname);
}

/** the host the daemon a menu is about answers at; with no socket (a test) the page's own, which
 * is where a test's daemon would be, and loopback where there is no page either */
export function daemonHost(sock: Pick<DaemonSocket, "urls"> | null | undefined): string {
  return sock?.urls.host ?? (typeof location === "object" ? location.hostname : "127.0.0.1");
}

/** the "open in <editor>" rows plus a Finder reveal, for anything that is a file on disk; none when
 * the page was opened from another device */
export function editorItems(absPath: string, onReveal: (() => void) | undefined, hostname: string): MenuItem[] {
  if (!openedOnDaemonMachine(hostname)) return [];
  const items: MenuItem[] = EDITORS.map((ed) => ({
    id: `open:${ed.scheme}`,
    label: `open in ${ed.label}`,
    onClick: () => {
      window.location.href = `${ed.scheme}://file${absPath}`;
    },
  }));
  items.push(...revealItems(onReveal, hostname));
  return items;
}

/** the Finder reveal alone, for a directory: a worktree's row offers no editor rows, since opening
 * a file in an editor is the way out of the editor pane and a whole copy is reached from its
 * terminal or its path */
export function revealItems(onReveal: (() => void) | undefined, hostname: string): MenuItem[] {
  if (!onReveal || !openedOnDaemonMachine(hostname)) return [];
  return [{ id: "reveal", label: "reveal in Finder", onClick: onReveal }];
}
