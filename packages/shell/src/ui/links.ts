import type { MouseEvent } from "react";

/** A page opened beside the shell. The page is someone else's (a PR, a preview, a link an agent
 * wrote), so it gets no handle on the window that opened it and is not told the shell's address. */
export function openOut(url: string | undefined) {
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

/** A press on rendered markdown that nothing routes: a link out opens beside the shell, and any
 * other is held, since followed in place it would navigate the shell itself away. */
export function holdLinks(e: MouseEvent) {
  const link = (e.target as Element).closest("a");
  if (link && link.target !== "_blank") e.preventDefault();
}
