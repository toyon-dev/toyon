// Transcripts are append-only JSONL under ~/.toyon/transcripts and in each archive, and an event's
// shape can change between releases. The code knows one shape, the current one; a stored line
// written in an older one is rewritten here, once, on the first boot after the upgrade. A reader
// that kept folding old shapes forever would pin every past shape into the daemon and the shell.

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.ts";

/** The pass this build makes, written to the stamp once every transcript has had it. Bumped with
 * each new rewrite, so the next upgrade's first boot reads the files again and no boot after
 * does: an archive is read at a restore, and listing hundreds of them must not mean reading them.
 * Step 4 renames the handoff list's events, which a machine stamped at 3 has never had read. */
export const FORWARD_STEP = "4";

type Stored = { event?: Record<string, unknown> & { type?: unknown; kind?: unknown } };

/** the words a line to touch carries, so the rest are never parsed */
const MARKS = ['"page', '"brief"', '"handoff', '"pieces'];

/** What becomes of a stored line: dropped, rewritten, or left as it is (null). Step 1: the
 * "preview threw" row 0.12.0 to 0.15.0 wrote onto the chat goes; the message its press sent
 * stays, since the agent's reply to it is on the chat, under the one asked kind that still says a
 * person pressed for it. Step 2: a message that carried another agent's brief becomes the
 * `handed` row that says so, with the brief as the text the row opens, since the brief no longer
 * rides on a bubble. Step 4: the handoff list's events, named `pieces-*` in 0.19 and 0.20, take
 * the `handoff-*` names, and so do the plan card's reference to its list and the asked kind. Up
 * to 0.18 a `handoff-proposed` held one piece and a `handoff` one worktree, under the very names
 * the list carries now, so those shapes become a list of one. A torn line, or a line of another
 * type that carries a word, is left. */
export function forwardLine(line: string): { drop: true } | { line: string } | null {
  if (!MARKS.some((m) => line.includes(m))) return null;
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
  if (e?.type === "user-message" && e.brief && typeof e.brief === "object") {
    const brief = e.brief as Record<string, unknown>;
    const { brief: _brief, ...rest } = e;
    return {
      line: JSON.stringify({
        ...entry,
        event: {
          ...rest,
          type: "handed",
          via: "message",
          body: brief.text,
          origin: brief.origin,
          ...(brief.note ? { note: brief.note } : {}),
        },
      }),
    };
  }
  const move = (event: Record<string, unknown>) => ({ line: JSON.stringify({ ...entry, event }) });
  if (e?.type === "fix-asked" && e.kind === "pieces") return move({ ...e, kind: "handoff" });
  if (e?.type === "agent-permission" && typeof e.pieces === "string") {
    const { pieces, ...rest } = e;
    return move({ ...rest, handoff: pieces });
  }
  if (e?.type === "handoff-proposed" && !Array.isArray(e.pieces)) {
    const repo = (e.repo ?? {}) as Record<string, unknown>;
    return move({
      type: "handoff-proposed",
      id: e.id,
      pieces: [
        {
          id: "p1",
          title: e.title ?? "Continue",
          plan: e.message ?? "",
          attachments: [],
          fate: "worktree",
          project: { id: repo.id, name: repo.name },
        },
      ],
      mode: e.mode,
      ts: e.ts,
    });
  }
  if (e?.type === "handoff" && !Array.isArray(e.outcomes)) {
    return move({
      type: "handoff",
      id: e.id,
      outcomes: [{ pieceId: "p1", fate: "worktree", worktreeId: e.worktreeId, title: e.title, repoName: e.repoName }],
      ts: e.ts,
    });
  }
  if (e?.type === "handoff-landed") return move({ ...e, type: "piece-landed" });
  if (e?.type === "pieces") return move({ ...e, type: "handoff" });
  if (typeof e?.type === "string" && e.type.startsWith("pieces-")) {
    const type = `handoff-${e.type.slice("pieces-".length)}`;
    // a piece's text was its `brief` before it was its `plan`
    const pieces = Array.isArray(e.pieces)
      ? {
          pieces: (e.pieces as Array<Record<string, unknown>>).map(({ brief, ...rest }) =>
            brief === undefined ? rest : { ...rest, plan: brief },
          ),
        }
      : {};
    return move({ ...e, type, ...pieces });
  }
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
