import type { FileViewer as Kind } from "@toyon/shared";
import { useRef } from "react";
import { imageItems } from "../../state/actions/message.ts";
import { FullAttachment } from "../../ui/FullAttachment.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { useContextMenu } from "../../ui/menu.ts";

type ViewProps = {
  src: string;
  path: string;
  /** the picture at the window's size; the pane's header offers it too, so the pane holds the switch */
  full: boolean;
  onFull: (v: boolean) => void;
};

/** a picture fitted to the pane; a press opens it at the window's size, as a picture in the chat
 * does. No tip on the press: the header names the action beside the picture already */
function ImageView({ src, path, full, onFull }: ViewProps) {
  const cm = useContextMenu("editor");
  return (
    <>
      <button
        type="button"
        className="editor-image"
        onClick={() => onFull(true)}
        {...cm.contextMenu(() => imageItems(src, { open: () => onFull(true) }))}
      >
        <img src={src} alt={path} />
      </button>
      {full && (
        <FullAttachment owner="editor" onClose={() => onFull(false)} menu={() => imageItems(src)}>
          <img src={src} alt={path} />
        </FullAttachment>
      )}
    </>
  );
}

/** the editor body for a file the browser draws rather than the text editor: one component per
 * kind, and a new kind is a row in the shared table and an entry here */
const VIEWERS: Record<Kind, (p: ViewProps) => React.JSX.Element> = {
  image: ImageView,
};

export function FileViewer({
  kind,
  src,
  path,
  openSeq,
  focus,
  full,
  onFull,
}: ViewProps & {
  kind: Kind;
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
      <View src={src} path={path} full={full} onFull={onFull} />
    </div>
  );
}
