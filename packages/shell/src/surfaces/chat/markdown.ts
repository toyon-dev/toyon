import createDOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { worktreeFileUrl } from "../../ws.ts";
import { assetPath } from "./markdownPaths.ts";
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
  },
});

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));

/** where a file's relative images are read from: the folder it sits in, in the worktree it is in */
export interface MarkdownBase {
  worktreeId: string;
  dir: string;
  version: string | null;
}

// an instance of its own, so the hook below never reaches a sanitize another module runs
const purify = createDOMPurify(window);
// sanitize is synchronous, so the base of the render in progress can sit here for the hook to read
let rendering: MarkdownBase | null = null;
purify.addHook("afterSanitizeAttributes", (node) => {
  // a link out leaves the shell standing: followed in place, it would navigate the whole app away
  if (node.tagName === "A" && /^https?:/i.test(node.getAttribute("href") ?? "")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer");
  }
  if (node.tagName === "IMG" && rendering) {
    const path = assetPath(rendering.dir, node.getAttribute("src") ?? "");
    if (path) node.setAttribute("src", worktreeFileUrl(rendering.worktreeId, path, rendering.version));
  }
});

/** markdown as sanitized HTML; with a base, a relative image is served from the worktree */
export function renderMarkdown(text: string, base?: MarkdownBase): string {
  rendering = base ?? null;
  try {
    return purify.sanitize(marked.parse(text, { async: false }) as string);
  } finally {
    rendering = null;
  }
}

/** parsing a long text on every change is O(n²) while it streams in; re-render at most every
 * ~100ms and settle immediately once the text stops changing */
export function useMarkdown(text: string, base?: MarkdownBase): string {
  const [html, setHtml] = useState(() => renderMarkdown(text, base));
  const lastAt = useRef(0);
  const worktreeId = base?.worktreeId;
  const dir = base?.dir;
  const version = base?.version;
  useEffect(() => {
    const at =
      worktreeId !== undefined && dir !== undefined ? { worktreeId, dir, version: version ?? null } : undefined;
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
  }, [text, worktreeId, dir, version]);
  return html;
}
