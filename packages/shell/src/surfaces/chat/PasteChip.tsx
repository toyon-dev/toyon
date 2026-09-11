import { type PasteSource, sourceLabel } from "@toyon/shared";
import { IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";

/** A block of pasted text, collapsed. Same chip family as the picked element and the image: a
 * close button only when it can be removed, so the transcript's copy is inert. */
export function PasteChip({
  n,
  name,
  source,
  lines,
  chars,
  preview,
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
  /** where the full text lives, once the daemon has stored it */
  href?: string;
  onRemove?: () => void;
  className?: string;
}) {
  // a piece of a file is named the way an editor names a selection; its directory, and the commit
  // when it is history, stand where a paste's counts would
  const dir = source?.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : "";
  const detail = source
    ? [dir, source.ref ? `at ${source.ref.slice(0, 7)}` : ""].filter(Boolean).join(" ")
    : [`${lines} ${lines === 1 ? "line" : "lines"}`, `${chars.toLocaleString()} chars`, preview]
        .filter(Boolean)
        .join(" · ");
  const label = (
    <>
      <Icon name="text" className="icon-inline" />
      <span className="pick-target">
        <b>{name ?? (source ? sourceLabel(source) : `Pasted text ${n}`)}</b>
        {detail && <span className="pick-file"> · {detail}</span>}
      </span>
    </>
  );
  return (
    <div className={cx("pick-chip paste-chip", className)} data-tip={preview || undefined}>
      {href ? (
        <a className="image-link" href={href} target="_blank" rel="noreferrer">
          {label}
        </a>
      ) : (
        label
      )}
      {onRemove && <IconButton icon="close" label="Remove attachment" tone="quiet" onClick={onRemove} />}
    </div>
  );
}
