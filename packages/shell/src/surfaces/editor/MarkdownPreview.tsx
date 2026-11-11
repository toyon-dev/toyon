import type { ReactNode } from "react";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useUrls } from "../../state/context.tsx";
import { readingView } from "../../state/store.ts";
import { Document } from "../../ui/Document.tsx";
import { useMarkdown } from "../chat/markdown.ts";
import { assetPath, dirOf } from "../chat/markdownPaths.ts";

/** a markdown file read rendered: the text the editor holds, so an agent writing it is seen as it
 * writes. `version` is the bytes on disk its relative images are served from; without one they are
 * left as written. A link to a file beside it opens that file. `onChat` takes what ⌘L selected, as
 * the page draws it: the render keeps no lines, so the pane names the file alone. `before` is the
 * text the file's diff is against: with `marks`, the page shows what came and went since, in one
 * column or, with `split`, as it was beside as it is. */
export function MarkdownPreview({
  text,
  before,
  marks = false,
  split = false,
  path,
  worktreeId,
  version,
  openSeq,
  focus,
  onChat,
  lead,
}: {
  text: string;
  before?: string;
  marks?: boolean;
  split?: boolean;
  path: string;
  worktreeId: string;
  version: string | null | undefined;
  openSeq: number;
  focus: boolean;
  onChat: (selected: string) => void;
  /** drawn at the head of the page, above the markdown */
  lead?: ReactNode;
}) {
  const sock = useSock();
  const urls = useUrls();
  const dispatch = useDispatch();
  const dir = dirOf(path);
  const options = {
    keepHtml: true,
    base: version === undefined ? undefined : { worktreeId, dir, version, urls },
  };
  const html = useMarkdown(text, options);
  // rendered whether or not the marks are on, so turning them on never draws a frame of the page
  // against nothing, every block of it new
  const was = useMarkdown(before ?? "", options);
  const onLink = (href: string) => {
    const target = assetPath(dir, href);
    if (target) openFile({ sock, dispatch }, { worktreeId, path: target, view: readingView(target) });
  };
  return (
    <Document
      html={html}
      before={marks && before !== undefined ? was : undefined}
      split={split}
      openSeq={openSeq}
      focus={focus}
      onLink={onLink}
      onChat={onChat}
      lead={lead}
    />
  );
}
