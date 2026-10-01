import { attachmentLabel, type PasteSource, sourceLabel } from "@toyon/shared";
import { useEffect, useState } from "react";
import { pasteItems } from "../../state/actions/message.ts";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";
import { AttachmentChip } from "./AttachmentChip.tsx";

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
        {detail && <span className="pick-file row-dim"> · {detail}</span>}
      </span>
    </>
  );
  // the composer still holds the text; the transcript has only where the daemon put it
  const canOpen = text !== undefined || href !== undefined;
  return (
    <AttachmentChip
      className={cx("paste-chip", className)}
      label={label}
      tip={preview || undefined}
      peek={canOpen ? <PastePeek text={text} href={href} /> : undefined}
      full={canOpen ? <FullPaste text={text} href={href} /> : undefined}
      menu={(ui) => pasteItems({ text, href }, ui)}
      removeLabel="Remove attachment"
      onRemove={onRemove}
    />
  );
}

/** The text the daemon kept, read back the way it went out. Fetched when it is first shown rather
 * than held with the row: a transcript can carry a hundred of these and none of them is being read.
 * The composer still holds its own, and that is used as it stands. */
function usePasteText(held: string | undefined, href: string | undefined) {
  const [text, setText] = useState<string | null>(held ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (held !== undefined || !href) return;
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
  }, [held, href]);

  return { text: held ?? text, failed };
}

function FullPaste({ text: held, href }: { text?: string; href?: string }) {
  const { text, failed } = usePasteText(held, href);
  if (failed) return <p className="paste-full hint">Toyon could not read that paste back.</p>;
  return <pre className="paste-full paste-text">{text}</pre>;
}

/** the peek clips what does not fit, so a paste of any length costs it only its opening */
const PEEK_CHARS = 20_000;

/** the opening of the paste beside the transcript; nothing until the text is in, and nothing when
 * it cannot be read: the press that opens it in full is where that is said */
function PastePeek({ text: held, href }: { text?: string; href?: string }) {
  const { text } = usePasteText(held, href);
  if (!text) return null;
  return <pre className="paste-peek paste-text">{text.slice(0, PEEK_CHARS)}</pre>;
}
