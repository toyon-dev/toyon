import { Fragment } from "react";
import type { Piece } from "./syntax.ts";

/** one line's worth of code: a span per run that carries a colour or a change, the rest as text.
 * A piece with neither is left bare rather than wrapped, which is most of a file. */
export function Painted({ pieces }: { pieces: Piece[] }) {
  return (
    <>
      {pieces.map((p, i) => {
        const cls = `${p.changed ? "ch " : ""}${p.scope ? `sy-${p.scope}` : ""}`.trim();
        // biome-ignore lint/suspicious/noArrayIndexKey: pieces are positional and never reordered
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
