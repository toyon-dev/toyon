import type { PrComment } from "@toyon/shared";
import { useMemo } from "react";
import { openFile } from "../../state/actions/file.ts";
import { addToChat } from "../../state/attach.ts";
import { useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { composerBoxOf, localOf, worktreeById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { Document } from "../../ui/Document.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { renderMarkdown } from "../chat/markdown.ts";
import { commentsLine, type PrThread, prPage, remarkLines, reviewVerb, threadName, threadText } from "./prComments.ts";
import "./prComments.css";

/** What reviewers wrote on the worktree's open PR, read as a page of its own in the editor pane:
 * the reviews' own words, then each file's threads by line. The chat has none of it until the
 * person hands a thread over, which puts it in the box as a chip and leaves the send to them. The
 * remarks are asked for on open and again whenever the summary on the worktree moves. */
export function PrCommentsPage({
  worktreeId,
  openSeq,
  focus,
}: {
  worktreeId: string;
  openSeq: number;
  focus: boolean;
}) {
  const sock = useSock();
  const pr = useStore((s) => worktreeById(s, worktreeId)?.worktree.pr);
  const summary = useStore((s) => worktreeById(s, worktreeId)?.worktree.prComments);
  const comments = useStore((s) => localOf(s, worktreeId).prComments);
  const version = summary?.version;
  // asked again when the summary's version moves, which is the daemon saying the remarks changed
  useOnChange([sock, worktreeId, version], () => {
    sock?.send({ t: "pr-comments", worktreeId });
  });
  const page = useMemo(() => prPage(comments ?? []), [comments]);
  const line = commentsLine(comments?.length ?? 0, summary?.authors ?? []);
  const lead = (
    <div className="md md-preview pr-page">
      <h1>{pr ? `PR #${pr.number}` : "Pull request"}</h1>
      <p className="pr-page-byline">
        {comments === undefined ? (
          "reading what reviewers wrote"
        ) : comments.length === 0 ? (
          "no comments yet"
        ) : (
          <>
            {line.count}
            {line.rest}
          </>
        )}
        {pr && (
          <>
            {" · "}
            <Button variant="inline" tone="quiet" onClick={() => window.open(pr.url, "_blank")}>
              on GitHub
            </Button>
          </>
        )}
      </p>
      {page.reviews.map((t) => (
        <Thread key={t.root.id} thread={t} worktreeId={worktreeId} />
      ))}
      {page.files.map((f) => (
        <section key={f.path}>
          {f.path && <h2 className="pr-page-path">{f.path}</h2>}
          {f.threads.map((t) => (
            <Thread key={t.root.id} thread={t} worktreeId={worktreeId} />
          ))}
        </section>
      ))}
    </div>
  );
  return <Document html="" openSeq={openSeq} focus={focus} lead={lead} />;
}

/** one remark and the answers to it */
function Thread({ thread, worktreeId }: { thread: PrThread; worktreeId: string }) {
  const store = useStoreInstance();
  const sock = useSock();
  const { root, replies } = thread;
  // the chip goes to the box on screen, which is this worktree's only while it is the one shown
  const canChat = useStore((s) => s.activeId === worktreeId && composerBoxOf(worktreeById(s, worktreeId)) !== null);
  const lines = remarkLines(root);
  const where = root.review ? (
    <span className="pr-page-verb" data-review={root.review}>
      {reviewVerb(root.review)}
    </span>
  ) : root.path && lines ? (
    <Button
      variant="inline"
      data-tip="Open the diff at this line"
      onClick={() =>
        root.path &&
        openFile(
          { sock, dispatch: store.dispatch },
          { worktreeId, path: root.path, view: "diff", ...(root.line ? { line: { n: root.line } } : {}) },
        )
      }
    >
      {root.startLine === undefined ? "line" : "lines"} {lines}
    </Button>
  ) : null;
  return (
    <div className="pr-page-thread">
      <div className="pr-page-head">
        <span className="pr-page-author">{root.author}</span>
        {where}
        <span className="pr-page-gap" />
        <GitHub url={root.url} />
        {canChat && (
          <Button
            variant="outline"
            tone="quiet"
            data-tip="Put this in the message box for the agent"
            onClick={() => addToChat(store, { worktreeId, text: threadText(thread), name: threadName(thread) })}
          >
            add to chat
          </Button>
        )}
      </div>
      {root.body && <Body text={root.body} />}
      {replies.map((r) => (
        <div key={r.id} className="pr-page-reply">
          <div className="pr-page-head">
            <span className="pr-page-author">{r.author}</span>
            <span className="pr-page-gap" />
            <GitHub url={r.url} />
          </div>
          <Body text={r.body} />
        </div>
      ))}
    </div>
  );
}

function GitHub({ url }: { url: PrComment["url"] }) {
  return (
    <Button variant="inline" tone="quiet" onClick={() => window.open(url, "_blank")}>
      GitHub
    </Button>
  );
}

function Body({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="pr-page-body"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
