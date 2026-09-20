/** A relative reference in a markdown file, as a path from the worktree root: `dir` is the file's
 * folder. Null for anything that is not a file beside it (a URL, a page anchor, a root-absolute path)
 * and for a path that climbs out of the worktree, which the daemon would refuse anyway. */
export function assetPath(dir: string, ref: string): string | null {
  if (!ref || ref.startsWith("#") || ref.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(ref)) return null;
  const bare = ref.split(/[?#]/)[0] ?? "";
  if (!bare) return null;
  const parts = dir ? dir.split("/") : [];
  for (const seg of bare.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(decodeURIComponent(seg));
    }
  }
  return parts.length ? parts.join("/") : null;
}

/** the folder a worktree path sits in, "" at the root */
export const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export interface WorktreeLink {
  path: string;
  line?: number;
  /** the link named a folder, with a trailing slash: it opens in the files tab, not the editor */
  folder?: true;
}

/** An absolute link the agent wrote to a file in this worktree, reduced to the path the daemon
 * accepts. The root boundary and `..` check matter before a chat link earns editor behaviour: a
 * filesystem-looking link outside the checkout stays an ordinary browser link. */
export function worktreeLink(root: string, ref: string): WorktreeLink | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    return null;
  }
  const hashLine = decoded.match(/#L(\d+)(?:-L?\d+)?$/i);
  if (hashLine) decoded = decoded.slice(0, hashLine.index);
  else decoded = decoded.split(/[?#]/)[0] ?? "";
  const suffixLine = decoded.match(/:(\d+)(?::\d+)?$/);
  if (suffixLine) decoded = decoded.slice(0, suffixLine.index);

  const base = root.replace(/\/+$/, "");
  if (!base || !decoded.startsWith(`${base}/`)) return null;
  const folder = decoded.endsWith("/");
  const path = decoded.slice(base.length + 1).replace(/\/+$/, "");
  if (!path || path.split("/").some((part) => part === "..")) return null;
  // the daemon reads files, and a folder is not one: the link is worth nothing to the editor, so
  // it carries no line, and the click opens it where folders open
  if (folder) return { path, folder: true };
  const lineText = hashLine?.[1] ?? suffixLine?.[1];
  const line = lineText ? Number.parseInt(lineText, 10) : undefined;
  return line && line > 0 ? { path, line } : { path };
}

/** A root-absolute link that is not a worktree file: a path on the daemon's disk, as the agent
 * wrote it. The browser would resolve it against the page and ask the daemon for a page it does not
 * serve, so it is never followed; the path is shown as text and offered to the editors instead.
 * Null for a URL, a page anchor and a relative reference. */
export function outsidePath(ref: string): string | null {
  if (!ref.startsWith("/") || ref.startsWith("//")) return null;
  try {
    return decodeURIComponent(ref);
  } catch {
    return null;
  }
}
