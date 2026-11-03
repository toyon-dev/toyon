import { useMemo, useRef } from "react";
import { FullAttachment } from "../../ui/FullAttachment.tsx";
import { useOnChange } from "../../ui/hooks.ts";

/** An svg file read rendered: the text the editor holds, drawn as a picture, so an agent writing
 * it is seen as it writes. The text goes in as an `<img>`, which is inert by spec: a script inside
 * it never runs, nothing it names outside itself loads, and it cannot reach the shell around it; a
 * sibling it references draws blank, which is the right reading of a file just written. Pressed,
 * or from the pane's head, it opens at the window's size as a picture does. */
export function SvgPreview({
  text,
  path,
  openSeq,
  focus,
  full,
  onFull,
}: {
  text: string;
  path: string;
  openSeq: number;
  focus: boolean;
  /** the picture at the window's size; the pane's header offers it too, so the pane holds the switch */
  full: boolean;
  onFull: (v: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // nothing in a picture takes focus on its own, so the seat does: Escape then finds the pane
  useOnChange([openSeq], () => {
    if (focus) ref.current?.focus();
  });
  // a data URL rather than an object URL: it is the text itself, with nothing to revoke, so an
  // effect that runs twice in development cannot let go of the one the picture is drawn from
  const src = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, [text]);
  return (
    <div ref={ref} className="editor-viewer editor-svg" tabIndex={-1}>
      <button type="button" className="editor-image" onClick={() => onFull(true)}>
        <img src={src} alt={path} />
      </button>
      {full && (
        <FullAttachment owner="editor" onClose={() => onFull(false)}>
          <img className="editor-svg-full" src={src} alt={path} />
        </FullAttachment>
      )}
    </div>
  );
}
