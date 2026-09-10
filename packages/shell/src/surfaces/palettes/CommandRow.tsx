import type { AgentCommand } from "@toyon/shared";
import { commandHits } from "./commands.ts";
import { markHits } from "./highlight.tsx";

/** One `/` row, in the composer and in ⌘K. The name is what gets typed, so it is what holds its
 * width; the description gives way and ellipsises. PaletteRow's hint slot never shrinks, which is
 * right for a chord and wrong for a sentence. */
export function CommandRow({ c, query }: { c: AgentCommand; query: string }) {
  const needle = query.trim();
  return (
    <>
      <span className="picker-name">/{markHits(c.name, needle ? commandHits(c.name, needle) : null, 0)}</span>
      <span className="picker-desc row-dim">{c.description}</span>
    </>
  );
}
