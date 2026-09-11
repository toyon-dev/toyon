import type { PickMeta } from "@toyon/shared";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import { copyText, type Deps } from "./deps.ts";
import { editorItems } from "./editor.ts";

/** a message in the transcript: its text as text, and for one the person wrote, back into the
 * composer to be said again with a change */
export function messageItems(
  item: { kind: "user" | "assistant" | "error"; text: string },
  worktreeId: string | null,
  { dispatch }: Deps,
): MenuEntry[] {
  const copy: MenuItem[] = [{ id: "copy", label: "copy message", onClick: () => copyText(item.text) }];
  const again: MenuItem[] = [];
  if (item.kind === "user" && worktreeId) {
    again.push({
      id: "draft",
      label: "edit in composer",
      onClick: () => dispatch({ a: "set-draft", id: worktreeId, text: item.text }),
    });
  }
  return grouped([copy, again]);
}

/** a picked element: the file it was rendered from, opened elsewhere; and off the message. A pick's
 * paths are relative to its checkout, so `dir` is the worktree they are read in; the editors need
 * the file on disk, and the path copied is the one the chip shows. */
export function pickItems(pick: PickMeta, ui: { dir?: string | null; remove?: () => void } = {}): MenuEntry[] {
  const file = pick.callFile ?? pick.file;
  const abs = file && (file.startsWith("/") ? file : ui.dir ? `${ui.dir}/${file}` : null);
  const open: MenuItem[] = abs ? editorItems(abs) : [];
  const copy: MenuItem[] = file ? [{ id: "copy-path", label: "copy path", onClick: () => copyText(file) }] : [];
  const remove: MenuItem[] = ui.remove ? [{ id: "remove", label: "remove", onClick: ui.remove }] : [];
  return grouped([open, copy, remove]);
}

/** a blocked call names a path: the file is still there to look at */
export function blockedItems(path: string, dir: string | null): MenuEntry[] {
  const abs = path.startsWith("/") ? path : dir ? `${dir}/${path}` : null;
  if (!abs) return [];
  return grouped([editorItems(abs), [{ id: "copy-path", label: "copy path", onClick: () => copyText(path) }]]);
}
