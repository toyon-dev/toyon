import type { PickMeta } from "@toyon/shared";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import { copyImage, copyText, copyTextFrom, type Deps, openOutItem } from "./deps.ts";
import { editorItems } from "./editor.ts";

/** what a chip can do besides what it is: opened at full size when the menu is on the chip and
 * not already inside that view, and taken off a message that has not gone yet */
export type ChipUi = { open?: () => void; remove?: () => void };

const chipTail = ({ open, remove }: ChipUi): MenuItem[][] => [
  open ? [{ id: "open", label: "open full size", onClick: open }] : [],
  remove ? [{ id: "remove", label: "remove", onClick: remove }] : [],
];

/** an attached image: the picture itself onto the clipboard, from the chip or from the full view */
export function imageItems(src: string, ui: ChipUi = {}): MenuEntry[] {
  return grouped([[{ id: "copy-image", label: "copy image", onClick: () => copyImage(src) }], ...chipTail(ui)]);
}

/** an attached paste: its whole text, which the composer still holds and the daemon serves back
 * for one that has been sent. A chip with neither offers nothing to copy. */
export function pasteItems(paste: { text?: string; href?: string }, ui: ChipUi = {}): MenuEntry[] {
  const { text, href } = paste;
  const copy: MenuItem[] =
    text !== undefined
      ? [{ id: "copy-text", label: "copy text", onClick: () => copyText(text) }]
      : href
        ? [{ id: "copy-text", label: "copy text", onClick: () => copyTextFrom(href) }]
        : [];
  return grouped([copy, ...chipTail(ui)]);
}

/** the link a message was right-clicked on: its address, and the worktree file it names when it
 * is one of those, so the menu is about the file rather than the address */
export type ChatLink = { href: string; file: { path: string; line?: number } | null };

/** a link out of the chat: the page outside the shell, and its address as text */
function linkItems(href: string): MenuItem[] {
  return [openOutItem(href), { id: "copy-link", label: "copy link", onClick: () => copyText(href) }];
}

/** a message in the transcript: what was under the pointer first, when that was a link, then its
 * text as text, and for one the person wrote, back into the composer to be said again with a
 * change. `dir` is the worktree's directory, which a file link's editors need. */
export function messageItems(
  item: { kind: "user" | "assistant" | "error"; text: string },
  worktreeId: string | null,
  { dispatch }: Deps,
  at: { link?: ChatLink | null; dir?: string | null } = {},
): MenuEntry[] {
  const link = at.link;
  const lead: MenuItem[][] = !link
    ? []
    : link.file
      ? pathGroups(link.file.path, at.dir ?? null)
      : [linkItems(link.href)];
  const copy: MenuItem[] = [{ id: "copy", label: "copy message", onClick: () => copyText(item.text) }];
  const again: MenuItem[] = [];
  if (item.kind === "user" && worktreeId) {
    again.push({
      id: "draft",
      label: "edit in composer",
      onClick: () => dispatch({ a: "set-draft", id: worktreeId, text: item.text }),
    });
  }
  return grouped([...lead, copy, again]);
}

/** a path a row names, as the groups every such row shares: the editors that can open it, then
 * the path as text. A relative path is read in `dir`, since the editors want a file on disk, and
 * the path copied is the one the row shows. */
function pathGroups(path: string, dir: string | null): MenuItem[][] {
  const abs = path.startsWith("/") ? path : dir ? `${dir}/${path}` : null;
  const open: MenuItem[] = abs ? editorItems(abs) : [];
  return [open, [{ id: "copy-path", label: "copy path", onClick: () => copyText(path) }]];
}

/** a row that is about a path and nothing else: a blocked call naming the file it wanted */
export function pathItems(path: string, dir: string | null): MenuEntry[] {
  return grouped(pathGroups(path, dir));
}

/** a picked element: the file it was rendered from, which is the call site when the pick found
 * one, as any path a row names; and off the message */
export function pickItems(pick: PickMeta, ui: { dir?: string | null; remove?: () => void } = {}): MenuEntry[] {
  const file = pick.callFile ?? pick.file;
  const path: MenuItem[][] = file ? pathGroups(file, ui.dir ?? null) : [];
  const remove: MenuItem[] = ui.remove ? [{ id: "remove", label: "remove", onClick: ui.remove }] : [];
  return grouped([...path, remove]);
}
