import type { FileViewer as Kind } from "@toyon/shared";
import { useRef } from "react";
import { useOnChange } from "../../ui/hooks.ts";

/** the editor body for a file the browser draws rather than the text editor: one component per
 * kind, and a new kind is a row in the shared table and an entry here */
const VIEWERS: Record<Kind, (p: { src: string; path: string }) => React.JSX.Element> = {
  image: ({ src, path }) => (
    <div className="editor-image">
      <img src={src} alt={path} />
    </div>
  ),
};

export function FileViewer({
  kind,
  src,
  path,
  openSeq,
  focus,
}: {
  kind: Kind;
  src: string;
  path: string;
  /** names the open, so the keyboard is handed over once per open and not on every fresh read */
  openSeq: number;
  /** the keyboard follows a file opened on purpose (Enter, a click); one walked to in a list stays there */
  focus: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // nothing in a picture takes focus on its own, so the body does: the pane then holds the
  // keyboard the way it does with the text editor, and Escape closes it
  useOnChange([openSeq], () => {
    if (focus) ref.current?.focus();
  });
  const View = VIEWERS[kind];
  return (
    <div ref={ref} className="editor-viewer" tabIndex={-1}>
      <View src={src} path={path} />
    </div>
  );
}
