import { type MouseEvent, useEffect, useMemo } from "react";
import type { Deps } from "../../state/actions/deps.ts";
import { listFiles } from "../../state/actions/file.ts";
import { useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { openChatLink } from "./chatLink.ts";
import { mentionIndex, mentionSpans } from "./mentions.ts";

/** a `@` opening a word: the shape a reference has before the file list says whether it is one */
const HAS_MENTION = /(^|\s)@\S/;

/** A message's text with its `@` references drawn as links: a file or folder as the link the
 * agent's prose gives one, the uncommitted set as a mark that opens the changes tab. A reference
 * is a link only when the worktree's file list holds it, so the mark says the agent has somewhere
 * to look and not that a sigil was typed. The links carry no handler of their own: the row they
 * sit in routes a press through `openMention`, as the agent's rows do through `openChatLink`. */
export function MentionText({
  text,
  worktreeId,
  root,
  inField,
}: {
  text: string;
  worktreeId?: string | null;
  /** the checkout's absolute path, which a link's href is built on */
  root?: string | null;
  /** drawn over the composer: the links are pressed with the pointer alone, so tab stays the field's */
  inField?: boolean;
}) {
  const store = useStoreInstance();
  const sock = useSock();
  const files = useStore((s) => (worktreeId ? s.local[worktreeId]?.files : undefined));
  const index = mentionIndex(files);
  const spans = useMemo(() => mentionSpans(text, index), [text, index]);
  // a reference with no list to check it against is prose until the list arrives, so the list is
  // asked for: the one cached list the @ menu and the files tab read, refreshed by whichever asks
  // first and left alone by the rest
  const wants = files === undefined && worktreeId && HAS_MENTION.test(text) ? worktreeId : null;
  useEffect(() => {
    if (wants) listFiles(wants, store.getState(), { sock, dispatch: store.dispatch });
  }, [wants, store, sock]);
  return (
    <>
      {spans.map((s, i) => {
        if (s.kind === "text") return s.text;
        if (s.kind === "changes") {
          const changesTip = tip("this worktree's uncommitted files", undefined, { placement: "follow" });
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and rebuilt whole with the text
            <span key={i} className="chat-mention" data-changes="" {...changesTip}>
              {s.text}
            </span>
          );
        }
        if (!root || !worktreeId) return s.text;
        const folder = s.kind === "folder";
        const href = `${root}/${s.path}${folder ? "/" : ""}`;
        const pathTip = tip(folder ? `${s.path}/` : s.path, undefined, { placement: "follow" });
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: same
          <a key={i} className="chat-mention" href={href} tabIndex={inField ? -1 : undefined} {...pathTip}>
            {s.text}
          </a>
        );
      })}
    </>
  );
}

/** a press on a row holding `MentionText`: `@changes` shows the changes tab, and a file or folder
 * opens as any file link in the transcript does */
export function openMention(
  e: MouseEvent,
  root: string | undefined | null,
  worktreeId: string | null | undefined,
  deps: Deps,
) {
  if ((e.target as Element).closest("[data-changes]")) {
    if (worktreeId) deps.dispatch({ a: "focus-changes", tab: "changes" });
    return;
  }
  openChatLink(e, root, worktreeId, deps);
}
