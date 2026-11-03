import { Fragment, type MouseEvent, useEffect, useMemo } from "react";
import type { Deps } from "../../state/actions/deps.ts";
import { listFiles } from "../../state/actions/file.ts";
import { useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { worktreeById } from "../../state/store.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { openChatLink } from "./chatLink.ts";
import { codeLink } from "./markdownGithub.ts";
import { mentionableWorktrees, mentionIndex, mentionSpans, mentionTip } from "./mentions.ts";
import { Painted } from "./Painted.tsx";
import { siblingWorktrees } from "./siblings.ts";
import { languageOf, linkLines, paintCode, paintPlain } from "./syntax.ts";

/** a fenced block from the person's own words, drawn as the agent's are: coloured by the seven
 * when the fence names a language we have a grammar for, an address in it a link either way */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const language = languageOf(lang.toLowerCase(), "");
  const lines = language ? linkLines(paintCode(code, language)) : paintPlain(code);
  return (
    <pre>
      <code>
        {lines.length
          ? lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and rebuilt whole with the text
              <Fragment key={i}>
                {i > 0 && "\n"}
                <Painted pieces={line} />
              </Fragment>
            ))
          : code}
      </code>
    </pre>
  );
}

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
  // the project's other open rows, then its archive, as the agent's own reference to a row
  // resolves. A chat with no project resolves none.
  const rows = useStore((s) => s.visible);
  const shipping = useStore((s) => s.shipping);
  const repoId = useStore((s) => worktreeById(s, worktreeId)?.worktree.repoId);
  const archived = useStore((s) => (repoId ? s.archived[repoId] : undefined));
  const worktrees = useMemo(
    () => mentionableWorktrees(siblingWorktrees(rows, repoId, worktreeId, shipping), archived),
    [rows, shipping, archived, repoId, worktreeId],
  );
  const index = useMemo(() => mentionIndex(files, worktrees), [files, worktrees]);
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
        // over the field the marks are the draft's characters, backticks included, so every mark
        // after a span stays on its word; the sent bubble draws the code the backticks named
        if (s.kind === "code") {
          if (inField) return s.text;
          // an address or an issue in backticks is the link to it, as it is in the agent's prose
          const href = codeLink(s.code);
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and rebuilt whole with the text
          const code = <code key={i}>{s.code}</code>;
          return href ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: same
            <a key={i} className="chat-url" href={href} target="_blank" rel="noreferrer">
              {code}
            </a>
          ) : (
            code
          );
        }
        if (s.kind === "block") {
          // biome-ignore lint/suspicious/noArrayIndexKey: same
          return inField ? s.text : <CodeBlock key={i} code={s.code} lang={s.lang} />;
        }
        // a link out, opened beside the shell as one in the agent's prose is; the row's router
        // leaves it to the browser (chatLink.ts)
        if (s.kind === "url") {
          return (
            <a
              // biome-ignore lint/suspicious/noArrayIndexKey: same
              key={i}
              className="chat-url"
              href={s.href}
              target="_blank"
              rel="noreferrer"
              tabIndex={inField ? -1 : undefined}
            >
              {s.text}
            </a>
          );
        }
        if (s.kind === "changes") {
          const changesTip = tip("this worktree's uncommitted files", undefined, { placement: "follow" });
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: same
            <span key={i} className="chat-mention" data-changes="" {...changesTip}>
              {s.text}
            </span>
          );
        }
        if (s.kind === "worktree") {
          const t = mentionTip(s);
          const rowTip = tip(t.text, undefined, { placement: "follow", dot: t.dot, detail: t.detail });
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: same
              key={i}
              className="chat-mention"
              data-worktree={s.id}
              data-branch={s.branch}
              data-archived={s.archived ? "" : undefined}
              {...rowTip}
            >
              {/* the name as the rail reads it with the row's dot trailing it, on the sent
                  message alone: over the field the mark is the draft again in the field's own
                  metrics, so it is the draft's characters, the title a pick wrote or a branch
                  typed by hand, and a dot in it would shift every mark after it off its word */}
              {inField ? (
                s.text
              ) : (
                <>
                  @{t.text}
                  {t.dot && (
                    <span className="chat-mention-dot">
                      <span className={`dot ${t.dot}`} />
                    </span>
                  )}
                </>
              )}
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

/** a press on a row holding `MentionText`: `@changes` shows the changes tab, and a worktree, a
 * file or a folder opens as it does in the agent's rows */
export function openMention(
  e: MouseEvent,
  root: string | undefined | null,
  worktreeId: string | null | undefined,
  deps: Deps,
) {
  const target = e.target as Element;
  if (target.closest("[data-changes]")) {
    if (worktreeId) deps.dispatch({ a: "focus-changes", tab: "changes" });
    return;
  }
  openChatLink(e, root, worktreeId, deps);
}
