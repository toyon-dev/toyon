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
