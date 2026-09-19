import { useRef } from "react";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import { readingView } from "../../state/store.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { useMarkdown } from "../chat/markdown.ts";
import { assetPath, dirOf } from "../chat/markdownPaths.ts";

/** a markdown file read rendered: the text the editor holds, so an agent writing it is seen as it
 * writes. `version` is the bytes on disk its relative images are served from; without one they are
 * left as written. */
export function MarkdownPreview({
  text,
  path,
  worktreeId,
  version,
  openSeq,
  focus,
}: {
  text: string;
  path: string;
  worktreeId: string;
  version: string | null | undefined;
  openSeq: number;
  focus: boolean;
}) {
  const sock = useSock();
  const dispatch = useDispatch();
  const dir = dirOf(path);
  const html = useMarkdown(text, version === undefined ? undefined : { base: { worktreeId, dir, version } });
  const ref = useRef<HTMLDivElement>(null);
  // nothing rendered takes focus on its own, so the body does, as a picture's does: Escape then
  // finds the pane
  useOnChange([openSeq], () => {
    if (focus) ref.current?.focus();
  });
  const onClick = (e: React.MouseEvent) => {
    const link = (e.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (!href || link?.target === "_blank") return;
    // a link inside the page would navigate the shell itself; one to a file beside it opens that file
    e.preventDefault();
    const target = assetPath(dir, href);
    if (target) openFile({ sock, dispatch }, { worktreeId, path: target, view: readingView(target) });
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the links inside are the controls; the root only routes their clicks
    <div ref={ref} className="editor-viewer editor-preview" tabIndex={-1} onClick={onClick}>
      <div
        className="md md-preview"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
