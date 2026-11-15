import { Fragment, useEffect, useMemo } from "react";
import { listFiles } from "../../state/actions/file.ts";
import { useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { chatRepoOf, rowById } from "../../state/store.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { collapseHome } from "../overlays/projectPicker.ts";
import { codeLink } from "./markdownGithub.ts";
import { mentionableWorktrees, mentionIndex, mentionSpans, mentionTip, namedPaths } from "./mentions.ts";
import { Painted } from "./Painted.tsx";
import type { PathKind } from "./pathComplete.ts";
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

/** the paths already asked about, by socket: an answer may be a while coming, and every bubble
 * that names the path would otherwise ask again in the meantime */
const askedPaths = new WeakMap<object, Set<string>>();
const NO_PATHS: string[] = [];
/** how long a draft sits still before the paths it names are asked about */
const ASK_IN_FIELD_MS = 300;
/** what is known of one path, as a letter: a message's paths are read as a word of these, so
 * the bubble is drawn again only when what is known of its own paths changes */
const KNOWN: Record<PathKind | "unknown", string> = { file: "f", folder: "d", none: "n", unknown: "?" };
const KIND_OF: Record<string, PathKind> = { f: "file", d: "folder", n: "none" };

/** A message's text with its `@` references drawn as links: a file or folder as the link the
 * agent's prose gives one, the uncommitted set as a mark that opens the changes tab. A reference
 * is a link only when the worktree's file list holds it, so the mark says the agent has somewhere
 * to look and not that a sigil was typed. The links carry no handler of their own: the row they
 * sit in routes a press through `openChatLink`, as the agent's rows do. */
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
  const repoId = useStore((s) => chatRepoOf(s, worktreeId));
  const archived = useStore((s) => (repoId ? s.archived[repoId] : undefined));
  const worktrees = useMemo(
    () => mentionableWorktrees(siblingWorktrees(rows, repoId, worktreeId, shipping), archived),
    [rows, shipping, archived, repoId, worktreeId],
  );
  // A path the message names on the machine's disk is a mark once the disk is known to hold it.
  const home = useStore((s) => s.home);
  const named = useMemo(() => (text.includes("/") ? namedPaths(text, home) : NO_PATHS), [text, home]);
  const known = useStore((s) => named.map((p) => KNOWN[s.pathKinds[p] ?? "unknown"]).join(""));
  const paths = useMemo(() => {
    if (named.length === 0) return undefined;
    const kinds: Record<string, PathKind> = {};
    named.forEach((p, i) => {
      const kind = KIND_OF[known[i] ?? ""];
      if (kind) kinds[p] = kind;
    });
    return { home, kinds };
  }, [named, known, home]);
  const index = useMemo(() => mentionIndex(files, worktrees, paths), [files, worktrees, paths]);
  const spans = useMemo(() => mentionSpans(text, index), [text, index]);
  // One nothing has spoken of is asked about, once. Over the field the ask waits for the draft
  // to sit still: the completion asks about the word under the caret as it is typed, and its
  // answers land in the same record, so what is left is a path typed past or pasted whole.
  useEffect(() => {
    if (!sock || !known.includes("?")) return;
    const ask = () => {
      let asked = askedPaths.get(sock);
      if (!asked) {
        asked = new Set();
        askedPaths.set(sock, asked);
      }
      named.forEach((path, i) => {
        if (known[i] !== "?" || asked.has(path)) return;
        asked.add(path);
        sock.send({ t: "browse-path", path });
      });
    };
    if (!inField) return ask();
    const timer = setTimeout(ask, ASK_IN_FIELD_MS);
    return () => clearTimeout(timer);
  }, [named, known, inField, sock]);
  // a reference with no list to check it against is prose until the list arrives, so the list is
  // asked for: the one cached list the @ menu and the files tab read, refreshed by whichever asks
  // first and left alone by the rest. An archived chat has no checkout to list, so nothing is
  // asked for it.
  const listed = useStore((s) => !!rowById(s, worktreeId));
  const wants = files === undefined && worktreeId && listed && HAS_MENTION.test(text) ? worktreeId : null;
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
        // a path on the machine's disk: the link the agent's prose gives one, which the row's
        // router opens here when it is in this checkout and asks the daemon for when it is not
        if (s.kind === "path") {
          const named = `${collapseHome(s.path, home)}${s.folder ? "/" : ""}`;
          return (
            <a
              // biome-ignore lint/suspicious/noArrayIndexKey: same
              key={i}
              className="chat-mention"
              href={s.folder ? `${s.path}/` : s.path}
              tabIndex={inField ? -1 : undefined}
              {...tip(named, undefined, { placement: "follow" })}
            >
              {s.text}
            </a>
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
