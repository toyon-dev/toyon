import type { MenuItem } from "../../ui/menu.ts";

const EDITORS: Array<{ label: string; scheme: string }> = [
  { label: "Zed", scheme: "zed" },
  { label: "VS Code", scheme: "vscode" },
  { label: "Cursor", scheme: "cursor" },
];

/** the "open in <editor>" rows plus a Finder reveal, for anything that is a file on disk */
export function editorItems(absPath: string, onReveal?: () => void): MenuItem[] {
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
