import type { MouseEvent } from "react";
import type { Deps } from "../../state/actions/deps.ts";
import { openFile, openFolder } from "../../state/actions/file.ts";
import type { ChatLink } from "../../state/actions/message.ts";
import { openByPath } from "../../state/openOutside.ts";
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
 * browser. The markup is the row's, so the row routes the press rather than each link */
export function openChatLink(
  e: MouseEvent,
  root: string | undefined | null,
  worktreeId: string | null | undefined,
  deps: Deps,
) {
  const link = chatLink(e.target as Element, root);
  if (link?.kind === "outside" && worktreeId) {
    // the daemon answers with the open, in whichever worktree the file sits in or loose under a
    // grant, and the same code the Dock icon's opens go through puts it in the pane
    e.preventDefault();
    openByPath(deps, worktreeId, link);
    return;
  }
  if (link?.kind !== "file" || !worktreeId) return;
  const target = link.file;
  e.preventDefault();
  if (target.folder) {
    openFolder(deps, { worktreeId, path: target.path });
    return;
  }
  // a message names a file because the agent touched it, so the view is left unsaid and the read
  // opens the diff when there is one, the file otherwise. A line is an address into whichever it
  // opens: the diff never folds around a line it is asked to show, so the line is in view either way.
  openFile(deps, {
    worktreeId,
    path: target.path,
    ...(target.line ? { line: { n: target.line } } : {}),
  });
}
