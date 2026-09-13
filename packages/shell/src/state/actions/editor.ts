import type { MenuItem } from "../../ui/menu.ts";

const EDITORS: Array<{ label: string; scheme: string }> = [
  { label: "Zed", scheme: "zed" },
  { label: "VS Code", scheme: "vscode" },
  { label: "Cursor", scheme: "cursor" },
];

/** The page is open on the machine the daemon runs on. An editor link opens the editor wherever the
 * browser is, naming a path on the daemon's disk, and a Finder reveal opens on the daemon's screen,
 * so from another device neither can do anything. */
export function openedOnDaemonMachine(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname.endsWith(".localhost")
  );
}

/** the "open in <editor>" rows plus a Finder reveal, for anything that is a file on disk; none when
 * the page was opened from another device */
export function editorItems(absPath: string, onReveal?: () => void, hostname = location.hostname): MenuItem[] {
  if (!openedOnDaemonMachine(hostname)) return [];
  const items: MenuItem[] = EDITORS.map((ed) => ({
    id: `open:${ed.scheme}`,
    label: `open in ${ed.label}`,
    onClick: () => {
      window.location.href = `${ed.scheme}://file${absPath}`;
    },
  }));
  if (onReveal) items.push({ id: "reveal", label: "reveal in Finder", onClick: onReveal });
  return items;
}
