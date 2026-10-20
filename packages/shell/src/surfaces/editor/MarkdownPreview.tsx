import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useUrls } from "../../state/context.tsx";
import { readingView } from "../../state/store.ts";
import { Document } from "../../ui/Document.tsx";
import { useMarkdown } from "../chat/markdown.ts";
import { assetPath, dirOf } from "../chat/markdownPaths.ts";

/** a markdown file read rendered: the text the editor holds, so an agent writing it is seen as it
 * writes. `version` is the bytes on disk its relative images are served from; without one they are
 * left as written. A link to a file beside it opens that file. `onChat` takes what ⌘L selected, as
 * the page draws it: the render keeps no lines, so the pane names the file alone. */
export function MarkdownPreview({
  text,
  path,
  worktreeId,
  version,
  openSeq,
  focus,
  onChat,
}: {
  text: string;
  path: string;
  worktreeId: string;
  version: string | null | undefined;
  openSeq: number;
  focus: boolean;
  onChat: (selected: string) => void;
}) {
  const sock = useSock();
  const urls = useUrls();
  const dispatch = useDispatch();
  const dir = dirOf(path);
  const html = useMarkdown(text, {
    keepHtml: true,
    base: version === undefined ? undefined : { worktreeId, dir, version, urls },
  });
  const onLink = (href: string) => {
    const target = assetPath(dir, href);
    if (target) openFile({ sock, dispatch }, { worktreeId, path: target, view: readingView(target) });
  };
  return <Document html={html} openSeq={openSeq} focus={focus} onLink={onLink} onChat={onChat} />;
}
