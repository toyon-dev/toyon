import { attachmentLabel, type PasteSource, sourceLabel } from "@toyon/shared";
import { useEffect, useState } from "react";
import { pasteItems } from "../../state/actions/message.ts";
import { IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";
import { useContextMenu } from "../../ui/menu.ts";
import { FullAttachment } from "./FullAttachment.tsx";

/** A block of pasted text, collapsed. Same chip family as the picked element and the image: a
 * close button only when it can be removed, so the transcript's copy is inert. */
export function PasteChip({
  n,
  name,
  source,
  lines,
  chars,
  preview,
  text,
  href,
  onRemove,
  className = "",
}: {
  n: number;
  name?: string;
  /** the file and lines it was copied from in the editor */
  source?: PasteSource;
  lines: number;
  chars: number;
  preview: string;
  /** the whole text, while the composer still holds it */
  text?: string;
  /** where the full text lives, once the daemon has stored it */
  href?: string;
  onRemove?: () => void;
  className?: string;
}) {
  // a piece of a file is named the way an editor names a selection; its directory, and the commit
  // when it is history, stand where a paste's counts would. A file named with no lines (a dropped
  // file, a selection out of a rendered document) keeps the counts, its directory ahead of them
  const at = source?.path ?? name ?? "";
  const dir = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
  const detail = source
    ? [dir, source.ref ? `at ${source.ref.slice(0, 7)}` : ""].filter(Boolean).join(" ")
    : [dir, `${lines} ${lines === 1 ? "line" : "lines"}`, `${chars.toLocaleString()} chars`, preview]
        .filter(Boolean)
        .join(" · ");
  const label = (
    <>
      <Icon name="text" className="icon-inline" />
      <span className="pick-target">
        <b>
          {name ? name.slice(name.lastIndexOf("/") + 1) : source ? sourceLabel(source) : attachmentLabel("paste", n)}
        </b>
        {detail && <span className="pick-file"> · {detail}</span>}
      </span>
    </>
  );
  const [full, setFull] = useState(false);
  const cm = useContextMenu("chat");
  const paste = { text, href };
  return (
    <div
      className={cx("pick-chip paste-chip", className)}
      data-tip={preview || undefined}
      {...cm.contextMenu(() => pasteItems(paste, { open: href ? () => setFull(true) : undefined, remove: onRemove }))}
    >
      {href ? (
        <button type="button" className="image-link" onClick={() => setFull(true)}>
          {label}
        </button>
      ) : (
        label
      )}
      {onRemove && <IconButton icon="close" label="Remove attachment" tone="quiet" onClick={onRemove} />}
      {full && href && (
        <FullAttachment onClose={() => setFull(false)} menu={() => pasteItems(paste)}>
          <FullPaste href={href} />
        </FullAttachment>
      )}
    </div>
  );
}

/** The text the daemon kept, read back the way it went out. Fetched when the box opens rather than
 * held with the row: a transcript can carry a hundred of these and none of them is being read. */
function FullPaste({ href }: { href: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(href)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => {
        if (live) setText(t);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [href]);

  if (failed) return <p className="paste-full hint">Toyon could not read that paste back.</p>;
  return <pre className="paste-full paste-text">{text}</pre>;
}
