// Transcripts are append-only JSONL under ~/.toyon/transcripts, and an event's shape can change
// between releases. The code knows one shape, the current one; a stored line written in an older
// one is rewritten here, once, on the first boot after the upgrade. A reader that kept folding
// old shapes forever would pin every past shape into the daemon and the shell.

import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.ts";

type Stored = { seq?: unknown; event?: { type?: unknown; message?: unknown; errors?: unknown } };

/** the line in the current shape, or null when it is already current or not one to touch: a torn
 * line, a line of another type */
export function forwardLine(line: string): string | null {
  if (!line.includes('"page-error"')) return null;
  let entry: Stored;
  try {
    entry = JSON.parse(line);
  } catch {
    return null; // a torn last line: parseTranscript skips it, and so does this
  }
  const e = entry.event;
  if (e?.type !== "page-error" || Array.isArray(e.errors) || typeof e.message !== "string") return null;
  // 0.12.0 wrote one throw per row as `message`; since then a row carries the list the page was
  // left throwing, as `errors`, oldest first
  const { message, ...rest } = e;
  return JSON.stringify({ ...entry, event: { ...rest, errors: [message] } });
}

/** a transcript's text with every old-shape line rewritten; `changed` counts the lines that moved */
export function forwardText(text: string): { text: string; changed: number } {
  let changed = 0;
  const lines = text.split("\n").map((line) => {
    const next = forwardLine(line);
    if (next === null) return line;
    changed++;
    return next;
  });
  return { text: changed ? lines.join("\n") : text, changed };
}

/** rewrite every transcript under `dir` that holds an old-shape line. Runs before the server
 * opens, so no client ever reads an old line; a file with nothing to move is not written. */
export function forwardTranscripts(dir: string): void {
  let files = 0;
  let rows = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const { text, changed } = forwardText(readFileSync(path, "utf8"));
    if (!changed) continue;
    // through a sibling and a rename, so a crash mid-write leaves the old file whole
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    files++;
    rows += changed;
  }
  if (files) log.info("transcripts", `rewrote ${rows} page-error row(s) in ${files} transcript(s) to the list shape`);
}
