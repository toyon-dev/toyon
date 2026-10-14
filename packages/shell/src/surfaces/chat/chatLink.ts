import type { MouseEvent } from "react";
import type { Deps } from "../../state/actions/deps.ts";
import { type ChatLink, linkOpener } from "../../state/actions/message.ts";
import { outsidePath, worktreeLink } from "./markdownPaths.ts";

/** the link at or around an element of a rendered message: the worktree file it names when the
 * checkout root is known, a file elsewhere on the daemon's disk, or a page out; a backticked
 * absolute path counts, as the path it names; null when the element is in none of these */
export function chatLink(target: Element, root: string | undefined | null): ChatLink | null {
  const a = target.closest("a, code[data-path]");
  if (!a) return null;
  const path = a.getAttribute("data-path");
  if (path) return { kind: "path", path };
  const href = a.getAttribute("href");
  if (!href) return null;
  const file = root ? worktreeLink(root, href) : null;
  if (file) return { kind: "file", file };
  const outside = outsidePath(href);
  return outside ? { kind: "outside", href, ...outside } : { kind: "out", href };
}

/** a press on a message: the file link under it opens in Toyon, and anything else is left to the
 * browser. The markup is the row's, so the row routes the press rather than each link. The open
 * itself is the link menu's "open" row, so the two never drift. */
export function openChatLink(
  e: MouseEvent,
  root: string | undefined | null,
  worktreeId: string | null | undefined,
  deps: Deps,
) {
  const link = chatLink(e.target as Element, root);
  // a backticked path is prose: a press on it selects text, and its open is its menu's alone
  const open = link && link.kind !== "path" ? linkOpener(link, worktreeId, deps) : null;
  if (!open) return;
  e.preventDefault();
  open();
}
