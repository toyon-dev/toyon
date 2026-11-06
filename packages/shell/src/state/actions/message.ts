import type { PickMeta } from "@toyon/shared";
import { grouped, type MenuEntry, type MenuFrom, type MenuItem } from "../../ui/menu.ts";
import { openByPath } from "../openOutside.ts";
import { copyImage, copyText, copyTextFrom, type Deps, openOutItem } from "./deps.ts";
import { daemonHost, openedOnDaemonMachine, revealItems } from "./editor.ts";
import { openFile, openFolder } from "./file.ts";

/** what a chip can do besides what it is: opened at full size when the menu is on the chip and
 * not already inside that view, and taken off a message that has not gone yet */
export type ChipUi = { open?: () => void; remove?: () => void };

/** the daemon's copy of an attachment a sent message carries, by the worktree and stored name the
 * chat fetches it by. It is the file the agent read, and the one file of the attachment this
 * machine has: the drag that attached it gave the bytes and never the path they came from. */
export type Kept = { worktreeId: string; file: string; sock: Deps["sock"] };

/** the ways to act on the chip, after what it holds: the open and the Finder reveal together, as
 * on a file link, since both are ways to the file; the path as text; then off the message. The
 * reveal says it lands on the copy: the person dragged a file from somewhere else, and Finder
 * opening on a numbered twin under Toyon's home would otherwise read as the wrong file. */
function chipTail({ open, remove }: ChipUi, kept?: Kept): MenuItem[][] {
  const sock = kept?.sock;
  const reveal =
    kept && sock
      ? () => sock.send({ t: "reveal-attachment", worktreeId: kept.worktreeId, file: kept.file })
      : undefined;
  const where = kept && sock ? sock.urls.attachmentWhere(kept.worktreeId, kept.file) : undefined;
  return [
    [
      ...(open ? [{ id: "open", label: "open full size", onClick: open }] : []),
      ...revealItems(reveal, daemonHost(sock), "reveal the copy"),
    ],
    where ? [{ id: "copy-path", label: "copy path", onClick: () => copyTextFrom(where) }] : [],
    remove ? [{ id: "remove", label: "remove", onClick: remove }] : [],
  ];
}

/** an attached image: the picture itself onto the clipboard, from the chip or from the full view */
export function imageItems(src: string, ui: ChipUi = {}, kept?: Kept): MenuEntry[] {
  return grouped([[{ id: "copy-image", label: "copy image", onClick: () => copyImage(src) }], ...chipTail(ui, kept)]);
}

/** text the daemon serves back or the composer still holds, onto the clipboard; nothing without either */
function copyTextItems({ text, href }: { text?: string; href?: string }): MenuItem[] {
  if (text !== undefined) return [{ id: "copy-text", label: "copy text", onClick: () => copyText(text) }];
  if (href) return [{ id: "copy-text", label: "copy text", onClick: () => copyTextFrom(href) }];
  return [];
}

/** an attached paste: its whole text, which the composer still holds and the daemon serves back
 * for one that has been sent. A chip with neither offers nothing to copy. */
export function pasteItems(paste: { text?: string; href?: string }, ui: ChipUi = {}): MenuEntry[] {
  return grouped([copyTextItems(paste), ...chipTail(ui)]);
}

/** an attached file: its text when it reads as text, then the chip's own ways, which for a sent
 * one reach the daemon's copy */
export function fileItems(file: { href?: string }, ui: ChipUi = {}, kept?: Kept): MenuEntry[] {
  return grouped([copyTextItems(file), ...chipTail(ui, kept)]);
}

/** the link a message was right-clicked on: a page out on the web, a file in this worktree, a file
 * linked outside it (which the daemon opens by its absolute path), a backticked path, which
 * has the file's menu and no click of its own, or a worktree of the project named by its branch */
export type ChatLink =
  | { kind: "out"; href: string }
  | { kind: "file"; file: { path: string; line?: number; folder?: true } }
  | { kind: "outside"; href: string; path: string; line?: number; folder?: true }
  | { kind: "path"; path: string }
  | { kind: "worktree"; id: string; branch: string; archived: boolean };

/** a link out of the chat: the page outside the shell, and its address as text */
/** a link out: opened beside the shell, or the address as text */
export function linkItems(href: string): MenuItem[] {
  return [openOutItem(href), { id: "copy-link", label: "copy link", onClick: () => copyText(href) }];
}

/** what opens a link, from the row or from its menu: a worktree file opens in Toyon's pane (a
 * folder in the files tab), and a file outside the worktree is asked of the daemon by its absolute
 * path. A backticked path is asked for the same way, and a refusal finds the span by that path, as
 * it finds a link by its href. Null when nothing opens. */
export function linkOpener(link: ChatLink, worktreeId: string | null | undefined, deps: Deps): (() => void) | null {
  // a row of the project opens wherever it is named, an archived one as its page
  if (link.kind === "worktree") {
    const { id, archived } = link;
    return () => deps.dispatch(archived ? { a: "open-archived", id } : { a: "activate", id });
  }
  // a folder outside the worktree has no place in Toyon, which shows only a worktree's folders,
  // so the press shows it where it sits; Finder opens on the daemon's screen, so from another
  // device nothing opens
  if (link.kind === "outside" && link.folder) return revealPathOpener(link.path, deps);
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

/** the Finder reveal of a path on the daemon's disk, when the page is open on that machine */
function revealPathOpener(path: string, { sock }: Deps): (() => void) | null {
  if (!sock || !openedOnDaemonMachine(daemonHost(sock))) return null;
  return () => sock.send({ t: "reveal-path", path });
}

/** a link to a file: the open the press makes, where it sits in Finder, then the path as text.
 * A file of this worktree is revealed through its row; any other path is revealed by where it is
 * on the daemon's disk. A folder outside the worktree has no open of its own: the reveal is what
 * its press does, so it leads alone. */
function fileLinkGroups(
  link: Exclude<ChatLink, { kind: "out" | "worktree" }>,
  worktreeId: string | null,
  deps: Deps,
): MenuItem[][] {
  const open = link.kind === "outside" && link.folder ? null : linkOpener(link, worktreeId, deps);
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

/** a worktree named in a message: the open the press makes, then its branch as text, which is
 * what the name on screen is and what `@` in the composer takes */
function worktreeGroups(link: Extract<ChatLink, { kind: "worktree" }>, deps: Deps): MenuItem[][] {
  const open = linkOpener(link, null, deps);
  return [
    open ? [{ id: "open", label: link.archived ? "open archived chat" : "open chat", onClick: open }] : [],
    [{ id: "copy-branch", label: "copy branch", onClick: () => copyText(link.branch) }],
  ];
}

/** a fenced block the menu was opened on: its text alone, without the prose around it */
export function codeItems(code: string | null | undefined): MenuItem[] {
  return code ? [{ id: "copy-code", label: "copy code", onClick: () => copyText(code) }] : [];
}

/** a message in the transcript: what was under the pointer first, when that was a fenced block
 * or a link, then its text as text, and for one the person wrote, back into the composer to be
 * said again with a change: the daemon rebuilds the box from the transcript, so what the message
 * carried comes back with its words. A finger on the prose itself gets no menu (`null`): a
 * long-press on text is how a phone selects it, and the browser gives that up when the event is
 * answered. Only a caller that says how the menu was asked for can get that answer. */
type MessageOf = { kind: "user" | "assistant" | "error"; text: string; seq?: number };
type MessageAt = { link?: ChatLink | null; code?: string | null };
export function messageItems(item: MessageOf, worktreeId: string | null, deps: Deps, at?: MessageAt): MenuEntry[];
export function messageItems(
  item: MessageOf,
  worktreeId: string | null,
  deps: Deps,
  at: MessageAt,
  from: MenuFrom,
): MenuEntry[] | null;
export function messageItems(
  item: MessageOf,
  worktreeId: string | null,
  deps: Deps,
  at: MessageAt = {},
  from: MenuFrom = "pointer",
): MenuEntry[] | null {
  if (from === "touch" && !at.link && !at.code) return null;
  const { dispatch, sock } = deps;
  const link = at.link;
  const lead: MenuItem[][] = !link
    ? []
    : link.kind === "out"
      ? [linkItems(link.href)]
      : link.kind === "worktree"
        ? worktreeGroups(link, deps)
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
