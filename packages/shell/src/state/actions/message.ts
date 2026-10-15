import type { PickMeta } from "@toyon/shared";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import { openByPath } from "../openOutside.ts";
import { copyImage, copyText, copyTextFrom, type Deps, openOutItem } from "./deps.ts";
import { daemonHost, revealItems } from "./editor.ts";
import { openFile, openFolder } from "./file.ts";

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

/** the link a message was right-clicked on: a page out on the web, a file in this worktree, a file
 * linked outside it (which the daemon opens by its absolute path), or a backticked path, which
 * has the file's menu and no click of its own */
export type ChatLink =
  | { kind: "out"; href: string }
  | { kind: "file"; file: { path: string; line?: number; folder?: true } }
  | { kind: "outside"; href: string; path: string; line?: number }
  | { kind: "path"; path: string };

/** a link out of the chat: the page outside the shell, and its address as text */
function linkItems(href: string): MenuItem[] {
  return [openOutItem(href), { id: "copy-link", label: "copy link", onClick: () => copyText(href) }];
}

/** what opens a link, from the row or from its menu: a worktree file opens in Toyon's pane (a
 * folder in the files tab), and a file outside the worktree is asked of the daemon by its absolute
 * path. A backticked path is asked for the same way, and a refusal finds the span by that path, as
 * it finds a link by its href. Null when nothing opens. */
export function linkOpener(link: ChatLink, worktreeId: string | null | undefined, deps: Deps): (() => void) | null {
  if (!worktreeId) return null;
  if (link.kind === "outside") return () => openByPath(deps, worktreeId, link);
  if (link.kind === "path") return () => openByPath(deps, worktreeId, { href: link.path, path: link.path });
  if (link.kind !== "file") return null;
  const target = link.file;
  if (target.folder) return () => openFolder(deps, { worktreeId, path: target.path });
  // a message names a file because the agent touched it, so the view is left unsaid and the read
  // opens the diff when there is one, the file otherwise. A line is an address into whichever it
  // opens: the diff never folds around a line it is asked to show, so the line is in view either way.
  return () => openFile(deps, { worktreeId, path: target.path, ...(target.line ? { line: { n: target.line } } : {}) });
}

/** a link to a file: the open the press makes, where it sits in Finder, then the path as text.
 * A file of this worktree is revealed through its row; any other path is revealed by where it is
 * on the daemon's disk. */
function fileLinkGroups(link: Exclude<ChatLink, { kind: "out" }>, worktreeId: string | null, deps: Deps): MenuItem[][] {
  const open = linkOpener(link, worktreeId, deps);
  const { sock } = deps;
  const reveal =
    link.kind === "file"
      ? worktreeId
        ? () => sock?.send({ t: "reveal", worktreeId, path: link.file.path })
        : undefined
      : () => sock?.send({ t: "reveal-path", path: link.path });
  const path = link.kind === "file" ? link.file.path : link.path;
  return [
    [...(open ? [{ id: "open", label: "open", onClick: open }] : []), ...revealItems(reveal, daemonHost(sock))],
    [{ id: "copy-path", label: "copy path", onClick: () => copyText(path) }],
  ];
}

/** a fenced block the menu was opened on: its text alone, without the prose around it */
export function codeItems(code: string | null | undefined): MenuItem[] {
  return code ? [{ id: "copy-code", label: "copy code", onClick: () => copyText(code) }] : [];
}

/** a message in the transcript: what was under the pointer first, when that was a fenced block
 * or a link, then its text as text, and for one the person wrote, back into the composer to be
 * said again with a change: the daemon rebuilds the box from the transcript, so what the message
 * carried comes back with its words. */
export function messageItems(
  item: { kind: "user" | "assistant" | "error"; text: string; seq?: number },
  worktreeId: string | null,
  deps: Deps,
  at: { link?: ChatLink | null; code?: string | null } = {},
): MenuEntry[] {
  const { dispatch, sock } = deps;
  const link = at.link;
  const lead: MenuItem[][] = !link
    ? []
    : link.kind === "out"
      ? [linkItems(link.href)]
      : fileLinkGroups(link, worktreeId, deps);
  const copy: MenuItem[] = [{ id: "copy", label: "copy message", onClick: () => copyText(item.text) }];
  const again: MenuItem[] = [];
  if (item.kind === "user" && worktreeId) {
    again.push({
      id: "draft",
      label: "edit in composer",
      onClick: () => {
        const seq = item.seq;
        // a message with no place in the transcript yet has only its words to give
        if (seq === undefined || !sock) return dispatch({ a: "set-draft", id: worktreeId, text: item.text });
        // the words in the box give way first: the daemon fills only an empty one
        dispatch({ a: "set-draft", id: worktreeId, text: "" });
        sock.send({ t: "redraft", worktreeId, seq });
      },
    });
  }
  return grouped([codeItems(at.code), ...lead, copy, again]);
}

/** a path a row names, as the groups every such row shares: the Finder reveal when the caller can
 * ask the daemon for one, then the path as text, which is the one the row shows. `host` is the
 * daemon's the file is on (editor.ts). */
function pathGroups(path: string, onReveal: (() => void) | undefined, host: string): MenuItem[][] {
  return [revealItems(onReveal, host), [{ id: "copy-path", label: "copy path", onClick: () => copyText(path) }]];
}

/** a row that is about a path and nothing else: a blocked call naming the file it wanted, or the
 * plan a worktree runs on, which is a file of the worktree and so can be shown in Finder */
export function pathItems(path: string, onReveal: (() => void) | undefined, host: string): MenuEntry[] {
  return grouped(pathGroups(path, onReveal, host));
}

/** a picked element: the file it was rendered from, which is the call site when the pick found
 * one, as any path a row names; and off the message */
export function pickItems(pick: PickMeta, ui: { remove?: () => void; host: string }): MenuEntry[] {
  const file = pick.callFile ?? pick.file;
  const path: MenuItem[][] = file ? pathGroups(file, undefined, ui.host) : [];
  const remove: MenuItem[] = ui.remove ? [{ id: "remove", label: "remove", onClick: ui.remove }] : [];
  return grouped([...path, remove]);
}
