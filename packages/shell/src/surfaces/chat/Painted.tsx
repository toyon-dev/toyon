import { Fragment } from "react";
import { LINK, type Piece } from "./syntax.ts";

/** one line's worth of code: a span per run that carries a colour or a change, the rest as text.
 * A piece with neither is left bare rather than wrapped, which is most of a file. An address is
 * the link out it reads as, opened beside the shell as a link in a reply is. */
export function Painted({ pieces }: { pieces: Piece[] }) {
  return (
    <>
      {pieces.map((p, i) => {
        if (p.scope === LINK) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: pieces are positional and never reordered
            <a key={i} className={p.changed ? "ch" : undefined} href={p.text} target="_blank" rel="noreferrer">
              {p.text}
            </a>
          );
        }
        const cls = `${p.changed ? "ch " : ""}${p.scope ? `sy-${p.scope}` : ""}`.trim();
        // biome-ignore lint/suspicious/noArrayIndexKey: same
        if (!cls) return <Fragment key={i}>{p.text}</Fragment>;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: same
          <span key={i} className={cls}>
            {p.text}
          </span>
        );
      })}
    </>
  );
}
