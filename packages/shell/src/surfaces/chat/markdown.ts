import type { ReplyPicture } from "@toyon/shared";
import createDOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { STREAM_TICK_MS } from "../../state/coalesce.ts";
import type { DaemonUrls } from "../../ws.ts";
import { closePendingLink, PENDING_LINK } from "./linkTail.ts";
import { dunder } from "./markdownDunder.ts";
import { escapeHtml, htmlAsText } from "./markdownHtml.ts";
import { assetPath, codePath, fromFileUrl, outsidePath, worktreeLink } from "./markdownPaths.ts";
import { table } from "./markdownTable.ts";
import { type WorktreeNamer, worktreeMention } from "./markdownWorktree.ts";
import { cutAt, nextPace, type Pace, shownAt } from "./pace.ts";
import { LINK, languageOf, linkLines, openTail, paintCode, paintPlain } from "./syntax.ts";

// a fenced block the agent wrote in a message is the same code as a fenced block under a tool call,
// so it is coloured by the same seven, and an address in it is the same link. marked hands the
// block over before it escapes it, and returning false hands one back that has nothing to paint.
marked.use({
  // the namer is read as each token renders, so it is the render in progress's (set below)
  extensions: [dunder, worktreeMention(() => rendering?.worktrees)],
  renderer: {
    code({ text, lang }) {
      const language = languageOf((lang ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "", "");
      let lines = language ? linkLines(paintCode(text, language)) : paintPlain(text);
      if (!lines.length) return false;
      // a fence still open at the end of a streaming reply: an address at its tail is not whole
      if (rendering?.streaming && source.trimEnd().endsWith(text.trimEnd())) lines = openTail(lines);
      const body = lines
        .map((line) =>
          line
            .map((p) =>
              p.scope === LINK
                ? `<a href="${escapeHtml(p.text)}">${escapeHtml(p.text)}</a>`
                : p.scope
                  ? `<span class="sy-${p.scope}">${escapeHtml(p.text)}</span>`
                  : escapeHtml(p.text),
            )
            .join(""),
        )
        .join("\n");
      return `<pre><code>${body}</code></pre>\n`;
    },
    // a tag in prose is text (markdownHtml.ts); a document a person wrote keeps its HTML
    html(token) {
      return rendering?.keepHtml ? false : htmlAsText(token);
    },
    // A picture a reply names by a path: the browser cannot read one, so the daemon copies the
    // file into the store (pictures.ts) and the still is drawn from the copy, pressed for the full
    // size. Until the copy is named, and for a path that is not a picture it could copy, the
    // caption stands as the file link `[caption](path)` would be: never the browser's broken
    // image. A web image is the browser's own; a document's images resolve on the img (below).
    image({ href, text }) {
      if (rendering?.base || /^(https?:|data:)/i.test(href)) return false;
      const stills = rendering?.stills;
      const kept = stills?.pictures.find((p) => p.path === href);
      const caption = escapeHtml(text);
      if (kept && stills) {
        const src = stills.urls.attachment(stills.worktreeId, kept.file);
        return `<button type="button" class="md-still" data-file="${attr(kept.file)}" data-tip="Open full size" data-tip-placement="follow"><img src="${attr(src)}" alt="${attr(text)}"></button>`;
      }
      const path = fromFileUrl(href);
      const root = rendering?.fileRoot;
      const link = path.startsWith("/") ? path : root ? `${root}/${path}` : null;
      return link ? `<a href="${attr(link)}">${caption}</a>` : caption;
    },
    table,
  },
});

/** text as an attribute's value, in double quotes */
const attr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

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
  /** the daemon's copies of the pictures a reply names by path, drawn in its place */
  stills?: { worktreeId: string; urls: DaemonUrls; pictures: readonly ReplyPicture[] };
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
// the text of the render in progress, for the code renderer to tell the fence at its end
let source = "";
// a `file://` link is read as the path it names, before the sanitizer measures the href against
// the schemes it allows (file: is not one) and drops it
purify.addHook("uponSanitizeAttribute", (node, data) => {
  if (node.tagName === "A" && data.attrName === "href") data.attrValue = fromFileUrl(data.attrValue);
});
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
    node.setAttribute(
      "data-tip",
      outside.folder ? `${outside.path}/` : `${outside.path}${outside.line ? `:${outside.line}` : ""}`,
    );
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
  source = options?.streaming ? closePendingLink(text) : text;
  try {
    return purify.sanitize(marked.parse(source, { async: false }) as string);
  } finally {
    rendering = null;
    source = "";
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
  const stills = options?.stills;
  const keepHtml = !!options?.keepHtml;
  const streaming = !!options?.streaming;
  const shown = usePaced(text, streaming);
  useEffect(() => {
    const base =
      worktreeId !== undefined && dir !== undefined && urls !== undefined
        ? { worktreeId, dir, version: version ?? null, urls }
        : undefined;
    const at =
      base || fileRoot || worktrees || stills || keepHtml || streaming
        ? { base, fileRoot, worktrees, stills, keepHtml, streaming }
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
  }, [shown, worktreeId, dir, version, urls, fileRoot, worktrees, stills, keepHtml, streaming]);
  return html;
}
