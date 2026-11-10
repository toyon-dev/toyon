import type { MouseEvent } from "react";
import type { Deps } from "../../state/actions/deps.ts";
import { type ChatLink, linkOpener } from "../../state/actions/message.ts";
import { outsidePath, relativeLink, worktreeLink } from "./markdownPaths.ts";

/** the link at or around an element of a rendered message: a worktree of the project named by
 * its branch, the worktree file it names when the checkout root is known (by its absolute path,
 * or by one written from the root), a file elsewhere on the daemon's disk, or a page out; a backticked absolute path counts, as the path it names;
 * null when the element is in none of these */
export function chatLink(target: Element, root: string | undefined | null): ChatLink | null {
  const row = target.closest("[data-worktree]");
  const id = row?.getAttribute("data-worktree");
  if (row && id) {
    return {
      kind: "worktree",
      id,
      branch: row.getAttribute("data-branch") ?? "",
      archived: row.hasAttribute("data-archived"),
    };
  }
  const a = target.closest("a, code[data-path]");
  if (!a) return null;
  const path = a.getAttribute("data-path");
  if (path) return { kind: "path", path };
  const href = a.getAttribute("href");
  if (!href) return null;
  const file = root ? (worktreeLink(root, href) ?? relativeLink(href)) : null;
  if (file) return { kind: "file", file };
  const outside = outsidePath(href);
  return outside ? { kind: "outside", href, ...outside } : { kind: "out", href };
}

/** a press on a message: a worktree named in it opens its row (an archived one its page), the
 * file link under it opens in Toyon, and a link out is left to the browser when it opens beside
 * the shell and held when it would not. The markup is the
 * row's, so the row routes the press rather than each link. The open itself is the link menu's
 * "open" row, so the two never drift. */
export function openChatLink(
  e: MouseEvent,
  root: string | undefined | null,
  worktreeId: string | null | undefined,
  deps: Deps,
) {
  const link = chatLink(e.target as Element, root);
  // a backticked path is prose: a press on it selects text, and its open is its menu's alone
  if (!link || link.kind === "path") return;
  if (link.kind === "out") {
    // only an http link is marked to open beside the shell (markdown.ts). Anything else followed
    // in place takes the whole app with it: `//host/path` to another site, and a relative link
    // with no root to read it from to a page of the daemon's that is not one
    if ((e.target as Element).closest("a")?.target !== "_blank") e.preventDefault();
    return;
  }
  // a path is never followed, whether or not anything opens: the browser would resolve it against
  // the page and ask the daemon for a page it does not serve
  e.preventDefault();
  linkOpener(link, worktreeId, deps)?.();
}
