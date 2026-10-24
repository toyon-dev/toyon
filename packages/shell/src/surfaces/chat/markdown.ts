import createDOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { STREAM_TICK_MS } from "../../state/coalesce.ts";
import type { DaemonUrls } from "../../ws.ts";
import { closePendingLink, PENDING_LINK } from "./linkTail.ts";
import { dunder } from "./markdownDunder.ts";
import { escapeHtml, htmlAsText } from "./markdownHtml.ts";
import { assetPath, codePath, outsidePath, worktreeLink } from "./markdownPaths.ts";
import { table } from "./markdownTable.ts";
import { type WorktreeNamer, worktreeMention } from "./markdownWorktree.ts";
import { cutAt, nextPace, type Pace, shownAt } from "./pace.ts";
import { languageOf, paintCode } from "./syntax.ts";

// a fenced block the agent wrote in a message is the same code as a fenced block under a tool call,
// so it is coloured by the same seven. marked hands the block over before it escapes it, and
// returning false hands one back in a language we have no grammar for.
marked.use({
  // the namer is read as each token renders, so it is the render in progress's (set below)
  extensions: [dunder, worktreeMention(() => rendering?.worktrees)],
  renderer: {
    code({ text, lang }) {
      const language = languageOf((lang ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "", "");
      if (!language) return false;
      const body = paintCode(text, language)
        .map((line) =>
          line
            .map((p) => (p.scope ? `<span class="sy-${p.scope}">${escapeHtml(p.text)}</span>` : escapeHtml(p.text)))
            .join(""),
        )
        .join("\n");
      return `<pre><code>${body}</code></pre>\n`;
    },
    // a tag in prose is text (markdownHtml.ts); a document a person wrote keeps its HTML
    html(token) {
      return rendering?.keepHtml ? false : htmlAsText(token);
    },
    table,
  },
});

/** where a file's relative images are read from: the folder it sits in, in the worktree it is in */
export interface MarkdownBase {
  worktreeId: string;
  dir: string;
  version: string | null;
  /** the daemon the file is on, which serves its images */
  urls: DaemonUrls;
}

export interface MarkdownOptions {
  /** where a rendered markdown document resolves its images */
  base?: MarkdownBase;
  /** the absolute checkout root: links beneath it open in Toyon's editor */
  fileRoot?: string;
  /** the project's worktrees by directory: a `wt-xxxx` in the prose reads as the row's title */
  worktrees?: WorktreeNamer;
  /** the text is a document written as markdown, whose raw HTML is part of it and is kept; a
   * reply, the default, draws a tag as the text it is */
  keepHtml?: boolean;
  /** the text is still arriving: it is shown at a reading pace, a few characters a frame (pace.ts),
   * and a link cut off at its end is held in place rather than shown raw */
  streaming?: boolean;
}

// an instance of its own, so the hook below never reaches a sanitize another module runs
const purify = createDOMPurify(window);
// sanitize is synchronous, so the base of the render in progress can sit here for the hook to read
let rendering: MarkdownOptions | null = null;
purify.addHook("afterSanitizeAttributes", (node) => {
  const href = node.tagName === "A" ? (node.getAttribute("href") ?? "") : "";
  // a link whose url is still streaming: its label sits where the link will, and nothing to open yet
  if (href === PENDING_LINK) {
    node.removeAttribute("href");
    node.classList.add("link-pending", "live-text");
    return;
  }
  // a link out leaves the shell standing: followed in place, it would navigate the whole app away
  if (/^https?:/i.test(href)) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer");
  }
  const file = rendering?.fileRoot ? worktreeLink(rendering.fileRoot, href) : null;
  const outside = file ? null : outsidePath(href);
  // a file anywhere on the daemon's disk is a place in Toyon: in this worktree it opens as the
  // file, elsewhere the daemon grants it, and both wear the same link
  if (file) {
    node.classList.add("file-link");
    node.setAttribute("data-tip", file.folder ? `${file.path}/` : `${file.path}${file.line ? `:${file.line}` : ""}`);
    node.setAttribute("data-tip-placement", "follow");
  } else if (outside) {
    node.classList.add("file-link");
    node.setAttribute("data-tip", `${outside.path}${outside.line ? `:${outside.line}` : ""}`);
    node.setAttribute("data-tip-placement", "follow");
  }
  // a backticked absolute path takes the path menu a link gets, though never its click. A fenced
  // block is code and not a path, and a code span inside a link is the link's label.
  if (node.tagName === "CODE" && !node.closest("pre, a")) {
    const path = codePath(node.textContent ?? "");
    if (path) node.setAttribute("data-path", path);
  }
  const base = rendering?.base;
  if (node.tagName === "IMG" && base) {
    const path = assetPath(base.dir, node.getAttribute("src") ?? "");
    if (path) node.setAttribute("src", base.urls.worktreeFile(base.worktreeId, path, base.version));
  }
});

/** markdown as sanitized HTML; with a base, a relative image is served from the worktree */
export function renderMarkdown(text: string, options?: MarkdownOptions): string {
  rendering = options ?? null;
  const source = options?.streaming ? closePendingLink(text) : text;
  try {
    return purify.sanitize(marked.parse(source, { async: false }) as string);
  } finally {
    rendering = null;
  }
}

/** the text as far as it is shown: while it streams, it grows a few characters a frame between
 * the deliveries that reach the store once a tick (pace.ts); otherwise it is the text. The text
 * on screen when pacing begins stays, and the whole text shows the moment streaming ends. */
function usePaced(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const pace = useRef<Pace | null>(null);
  useEffect(() => {
    if (!streaming) {
      pace.current = null;
      return;
    }
    pace.current = nextPace(pace.current, text.length, performance.now());
    let frame = 0;
    const tick = () => {
      const p = pace.current;
      if (!p) return;
      const n = shownAt(p, performance.now());
      setShown(cutAt(text, n));
      if (n < p.to) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [text, streaming]);
  return streaming ? shown : text;
}

/** parsing a long text on every change is O(n²) while it is typed into the editor beside its
 * preview; re-render at most once a reading tick (the cadence streamed text reaches the store at,
 * coalesce.ts) and settle at once when the text stops changing. Text that streams in is paced
 * instead, and renders as each frame's few characters are shown: a parse costs well under a
 * millisecond for a page of text, and the pace is the cadence. */
export function useMarkdown(text: string, options?: MarkdownOptions): string {
  const [html, setHtml] = useState(() => renderMarkdown(text, options));
  const lastAt = useRef(0);
  const worktreeId = options?.base?.worktreeId;
  const dir = options?.base?.dir;
  const version = options?.base?.version;
  const urls = options?.base?.urls;
  const fileRoot = options?.fileRoot;
  const worktrees = options?.worktrees;
  const keepHtml = !!options?.keepHtml;
  const streaming = !!options?.streaming;
  const shown = usePaced(text, streaming);
  useEffect(() => {
    const base =
      worktreeId !== undefined && dir !== undefined && urls !== undefined
        ? { worktreeId, dir, version: version ?? null, urls }
        : undefined;
    const at =
      base || fileRoot || worktrees || keepHtml || streaming
        ? { base, fileRoot, worktrees, keepHtml, streaming }
        : undefined;
    const since = performance.now() - lastAt.current;
    if (streaming || since >= STREAM_TICK_MS) {
      lastAt.current = performance.now();
      setHtml(renderMarkdown(shown, at));
      return;
    }
    const t = setTimeout(() => {
      lastAt.current = performance.now();
      setHtml(renderMarkdown(shown, at));
    }, STREAM_TICK_MS - since);
    return () => clearTimeout(t);
  }, [shown, worktreeId, dir, version, urls, fileRoot, worktrees, keepHtml, streaming]);
  return html;
}
