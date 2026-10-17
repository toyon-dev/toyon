// Transcripts are append-only JSONL under ~/.toyon/transcripts and in each archive, and an event's
// shape can change between releases. The code knows one shape, the current one; a stored line
// written in an older one is rewritten here, once, on the first boot after the upgrade. A reader
// that kept folding old shapes forever would pin every past shape into the daemon and the shell.

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.ts";

/** The pass this build makes, written to the stamp once every transcript has had it. Bumped with
 * each new rewrite, so the next upgrade's first boot reads the files again and no boot after
 * does: an archive is read at a restore, and listing hundreds of them must not mean reading them. */
export const FORWARD_STEP = "1";

type Stored = { event?: { type?: unknown; kind?: unknown } };

/** the word every line to touch carries, so the rest are never parsed */
const MARK = '"page';

/** What becomes of a stored line: dropped, rewritten, or left as it is (null). The "preview
 * threw" row 0.12.0 to 0.15.0 wrote onto the chat goes; the message its press sent stays, since
 * the agent's reply to it is on the chat, under the one asked kind that still says a person
 * pressed for it. A torn line, or a line of another type that carries the word, is left. */
export function forwardLine(line: string): { drop: true } | { line: string } | null {
  if (!line.includes(MARK)) return null;
  let entry: Stored;
  try {
    entry = JSON.parse(line);
  } catch {
    return null; // a torn last line: parseTranscript skips it, and so does this
  }
  const e = entry.event;
  if (e?.type === "page-error") return { drop: true };
  if (e?.type === "fix-asked" && e.kind === "page")
    return { line: JSON.stringify({ ...entry, event: { ...e, kind: "command" } }) };
  return null;
}

/** a transcript's text with every old-shape line moved on; `changed` counts the lines touched */
export function forwardText(text: string): { text: string; changed: number } {
  let changed = 0;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const next = forwardLine(line);
    if (next === null) lines.push(line);
    else {
      changed++;
      if ("line" in next) lines.push(next.line);
    }
  }
  return { text: changed ? lines.join("\n") : text, changed };
}

/** Rewrite every transcript under `dirs` that holds an old-shape line: the live ones, each a
 * `.jsonl` in the directory, and the archives, each a `transcript.jsonl` one directory down.
 * Runs before the server opens, so no client ever reads an old line, and once: `stamp` names
 * the file that records the step the files are at. A file with nothing to move is not written. */
export function forwardTranscripts(dirs: readonly string[], stamp: string): void {
  if (readStamp(stamp) === FORWARD_STEP) return;
  let files = 0;
  let rows = 0;
  for (const path of dirs.flatMap(transcriptsUnder)) {
    const { text, changed } = forwardText(readFileSync(path, "utf8"));
    if (!changed) continue;
    // through a sibling and a rename, so a crash mid-write leaves the old file whole
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    files++;
    rows += changed;
  }
  writeFileSync(stamp, FORWARD_STEP);
  if (files) log.info("transcripts", `moved ${rows} row(s) in ${files} transcript(s) past the preview-threw row`);
}

function readStamp(stamp: string): string | null {
  try {
    return readFileSync(stamp, "utf8").trim();
  } catch {
    return null; // never stamped: a first boot, or one before stamps
  }
}

function transcriptsUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(join(dir, entry.name));
    else if (entry.isDirectory()) {
      // a directory with no transcript in it is not an archive
      const inner = join(dir, entry.name, "transcript.jsonl");
      if (existsSync(inner)) found.push(inner);
    }
  }
  return found;
}
