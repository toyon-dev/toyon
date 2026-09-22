import { useMemo, useRef } from "react";
import { useOnChange } from "../../ui/hooks.ts";
import { worktreeFileUrl } from "../../ws.ts";
import { assetPath, dirOf } from "../chat/markdownPaths.ts";

/** where a page's relative assets are read from: the folder it sits in, in the worktree it is in */
interface HtmlBase {
  worktreeId: string;
  dir: string;
  version: string | null;
}

/** the attributes a page reaches beside itself through: a picture, a stylesheet, a poster, a
 * clip's source. A script is not here, since none runs in the frame. */
const REFS = "img[src], source[src], video[src], audio[src], video[poster], link[href], object[data]";

/** The page's text with each relative asset pointed at the daemon, so a picture or stylesheet
 * beside the file draws inside the frame. A page that reaches for nothing beside it is returned as
 * written: parsing and serialising again is a change to the bytes for no gain. */
export function rebaseHtml(text: string, base: HtmlBase | null): string {
  if (!base) return text;
  const doc = new DOMParser().parseFromString(text, "text/html");
  let moved = false;
  for (const el of doc.querySelectorAll(REFS)) {
    for (const attr of ["src", "href", "poster", "data"]) {
      const ref = el.getAttribute(attr);
      const path = ref === null ? null : assetPath(base.dir, ref);
      if (!path) continue;
      el.setAttribute(attr, worktreeFileUrl(base.worktreeId, path, base.version));
      moved = true;
    }
  }
  if (!moved) return text;
  return `${doc.doctype ? "<!doctype html>\n" : ""}${doc.documentElement.outerHTML}`;
}

/** an html file read rendered: the text the editor holds, drawn in a frame of its own, so an agent
 * writing it is seen as it writes. The frame is fully sandboxed: a reading of the page, not a run
 * of it. Its scripts stay off, so the page can reach neither the shell around it nor the token in
 * its asset addresses; running it is what the preview is for. `version` is the bytes on disk its
 * relative assets are served from; without one they are left as written. */
export function HtmlPreview({
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
  const ref = useRef<HTMLDivElement>(null);
  // nothing in a sandboxed frame hands the keyboard back, so the seat takes it, as a picture's
  // does: Escape then finds the pane
  useOnChange([openSeq], () => {
    if (focus) ref.current?.focus();
  });
  const dir = dirOf(path);
  const doc = useMemo(
    () => rebaseHtml(text, version === undefined ? null : { worktreeId, dir, version }),
    [text, worktreeId, dir, version],
  );
  return (
    <div ref={ref} className="editor-viewer" tabIndex={-1}>
      <iframe className="editor-frame" title={path} sandbox="" srcDoc={doc} />
    </div>
  );
}
