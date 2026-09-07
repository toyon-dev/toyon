import { Icon } from "../../ui/Icon.tsx";

/** A block of pasted text, collapsed. Same chip family as the picked element and the image: a
 * close button only when it can be removed, so the transcript's copy is inert. */
export function PasteChip({
  n,
  name,
  lines,
  chars,
  preview,
  href,
  onRemove,
  className = "",
}: {
  n: number;
  name?: string;
  lines: number;
  chars: number;
  preview: string;
  /** where the full text lives, once the daemon has stored it */
  href?: string;
  onRemove?: () => void;
  className?: string;
}) {
  const label = (
    <>
      <Icon name="text" className="icon-inline" />
      <span className="pick-target">
        <b>{name ?? `Pasted text ${n}`}</b>
        <span className="pick-file">
          {lines} {lines === 1 ? "line" : "lines"} · {chars.toLocaleString()} chars{preview ? ` · ${preview}` : ""}
        </span>
      </span>
    </>
  );
  return (
    <div className={`pick-chip paste-chip ${className}`} data-tip={preview || undefined}>
      {href ? (
        <a className="image-link" href={href} target="_blank" rel="noreferrer">
          {label}
        </a>
      ) : (
        label
      )}
      {onRemove && (
        <button type="button" data-tip="Remove attachment" aria-label="Remove attachment" onClick={onRemove}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}
