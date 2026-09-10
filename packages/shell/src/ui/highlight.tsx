import type { ReactNode } from "react";

/** wrap the matched characters of one text segment (which starts at `offset` within the full string) */
export function markHits(text: string, hits: number[] | null, offset: number): ReactNode {
  if (!hits) return text;
  const set = new Set(hits.map((h) => h - offset));
  const out: ReactNode[] = [];
  let run = "";
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (run) out.push(run);
      run = "";
      out.push(
        <b key={i} className="hit">
          {text[i]}
        </b>,
      );
    } else run += text[i];
  }
  if (run) out.push(run);
  return out;
}
