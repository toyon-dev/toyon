import createDOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { worktreeFileUrl } from "../../ws.ts";
import { closePendingLink, PENDING_LINK } from "./linkTail.ts";
import { assetPath, outsidePath, worktreeLink } from "./markdownPaths.ts";
import { table } from "./markdownTable.ts";
import { languageOf, paintCode } from "./syntax.ts";

// a fenced block the agent wrote in a message is the same code as a fenced block under a tool call,
// so it is coloured by the same seven. marked hands the block over before it escapes it, and
// returning false hands one back in a language we have no grammar for.
marked.use({
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
    table,
  },
});

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));

/** where a file's relative images are read from: the folder it sits in, in the worktree it is in */
export interface MarkdownBase {
  worktreeId: string;
  dir: string;
  version: string | null;
}

export interface MarkdownOptions {
  /** where a rendered markdown document resolves its images */
  base?: MarkdownBase;
  /** the absolute checkout root: links beneath it open in Toyon's editor */
  fileRoot?: string;
  /** the text is still arriving: a link cut off at its end is held in place rather than shown raw */
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
  if (file) {
    node.classList.add("file-link");
    node.setAttribute("data-tip", file.folder ? `${file.path}/` : `${file.path}${file.line ? `:${file.line}` : ""}`);
    node.setAttribute("data-tip-placement", "follow");
  } else if (href) {
    const path = outsidePath(href);
    if (path) {
      // a path the daemon cannot serve is not a link: without its href the anchor is text, and the
      // path stands in the mono like any other path the agent names in prose
      node.removeAttribute("href");
      node.classList.add("path-text");
      node.setAttribute("data-path", path);
      if (!(node.childNodes.length === 1 && node.firstElementChild?.tagName === "CODE")) {
        const code = node.ownerDocument.createElement("code");
        code.append(...Array.from(node.childNodes));
        node.append(code);
      }
    }
  }
  const base = rendering?.base;
  if (node.tagName === "IMG" && base) {
    const path = assetPath(base.dir, node.getAttribute("src") ?? "");
    if (path) node.setAttribute("src", worktreeFileUrl(base.worktreeId, path, base.version));
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

/** parsing a long text on every change is O(n²) while it streams in; re-render at most every
 * ~100ms and settle immediately once the text stops changing */
export function useMarkdown(text: string, options?: MarkdownOptions): string {
  const [html, setHtml] = useState(() => renderMarkdown(text, options));
  const lastAt = useRef(0);
  const worktreeId = options?.base?.worktreeId;
  const dir = options?.base?.dir;
  const version = options?.base?.version;
  const fileRoot = options?.fileRoot;
  const streaming = options?.streaming;
  useEffect(() => {
    const base =
      worktreeId !== undefined && dir !== undefined ? { worktreeId, dir, version: version ?? null } : undefined;
    const at = base || fileRoot || streaming ? { base, fileRoot, streaming } : undefined;
    const since = performance.now() - lastAt.current;
    if (since >= 100) {
      lastAt.current = performance.now();
      setHtml(renderMarkdown(text, at));
      return;
    }
    const t = setTimeout(() => {
      lastAt.current = performance.now();
      setHtml(renderMarkdown(text, at));
    }, 100 - since);
    return () => clearTimeout(t);
  }, [text, worktreeId, dir, version, fileRoot, streaming]);
  return html;
}
