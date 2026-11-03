// The agent's rows draw a worktree's name as a mark (markdownWorktree.ts) from names that settle
// once per status tick on purpose: re-rendering every message's markdown for the colour of a dot
// is not a thing to do. So a live row's mark goes out with an empty dot, and the log stamps the
// rows' state onto the marks in place: the dot's colour, and the tip's state and last-send lines.
// The person's own marks (Mentions.tsx) render from the store and carry no directory, so the
// stamp leaves them alone.

import { type RefObject, useEffect } from "react";
import { useStore } from "../../state/context.tsx";
import { worktreeById } from "../../state/store.ts";
import { FOOT, inFoot } from "./foot.ts";
import { mentionTip } from "./mentions.ts";
import { type Sibling, siblingWorktrees } from "./siblings.ts";

export function stampMentions(root: ParentNode, rows: readonly Sibling[]) {
  const byId = new Map(rows.map((w) => [w.id, w]));
  // the box at the log's foot draws the person's marks from the store already
  for (const el of root.querySelectorAll<HTMLElement>(`.chat-mention[data-dir]:not([data-archived], :is(${FOOT}) *)`)) {
    const w = byId.get(el.dataset.worktree ?? "");
    if (!w) continue;
    const t = mentionTip({ ...w, dir: el.dataset.dir });
    const dot = el.querySelector(".dot");
    const cls = `dot ${w.dot}`;
    if (dot && dot.className !== cls) dot.className = cls;
    const detail = t.detail.join("\n");
    if (el.dataset.tipDetail !== detail) el.dataset.tipDetail = detail;
    if (el.dataset.tipDot !== w.dot) el.dataset.tipDot = w.dot;
  }
}

/** keeps the marks under `logRef` current: on every change of the rows, and as marks land (a
 * reply streaming in, a row the cache brings back), caught by watching the log's children */
export function useMentionDots(logRef: RefObject<HTMLElement | null>, worktreeId: string | null) {
  const rows = useStore((s) => s.visible);
  const shipping = useStore((s) => s.shipping);
  const repoId = useStore((s) => worktreeById(s, worktreeId)?.worktree.repoId);
  useEffect(() => {
    const root = logRef.current;
    if (!root || !repoId) return;
    const siblings = siblingWorktrees(rows, repoId, null, shipping);
    stampMentions(root, siblings);
    let frame = 0;
    const observer = new MutationObserver((records) => {
      // a keystroke in the box redraws its ghost and marks under the same root; no row moved
      if (records.every((r) => inFoot(r.target))) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => stampMentions(root, siblings));
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [logRef, rows, shipping, repoId]);
}
