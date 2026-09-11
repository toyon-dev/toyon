// A selection copied in the editor, as the file or as its diff, carries the file and lines it came
// from on the clipboard, in a flavour of our own beside the text, so a paste into the composer can
// say where it is from. The editor reports the lines; the pane adds whose file they are. A custom
// type round-trips through the system clipboard inside the browser (monaco's multi-cursor paste
// rides the same way), and the next copy anywhere replaces it along with the text, so it never
// describes a different text than the one pasted.

import type { PasteSource } from "@toyon/shared";

const FLAVOUR = "application/x-toyon-source";

/** what a copy writes: the source, and the worktree whose file it is */
export interface CopiedSource extends PasteSource {
  worktreeId: string;
}

/** the lines a monaco selection covers. One dragged down to the start of the next line has taken
 * none of that line; a copy with nothing selected takes the whole line under the caret. */
export function selectedLines(s: { startLineNumber: number; endLineNumber: number; endColumn: number }) {
  const endLine = s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber;
  return { startLine: s.startLineNumber, endLine };
}

export function writeCopiedSource(data: Pick<DataTransfer, "setData">, source: CopiedSource): void {
  data.setData(FLAVOUR, JSON.stringify(source));
}

const isLine = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1;

/** the source behind a paste into the composer on `worktreeId`, or null. A copy from another
 * worktree names lines of a different checkout, so it pastes as plain text. */
export function readCopiedSource(data: Pick<DataTransfer, "getData">, worktreeId: string | null): PasteSource | null {
  const raw = data.getData(FLAVOUR);
  if (!raw || !worktreeId) return null;
  let v: Partial<Record<keyof CopiedSource, unknown>> | null;
  try {
    v = JSON.parse(raw);
  } catch {
    // only this module writes the flavour, so a value that does not parse is not ours to read
    return null;
  }
  if (!v || v.worktreeId !== worktreeId || typeof v.path !== "string" || !v.path) return null;
  const { startLine, endLine, ref } = v;
  if (!isLine(startLine) || !isLine(endLine) || endLine < startLine) return null;
  return { path: v.path, startLine, endLine, ...(typeof ref === "string" ? { ref } : {}) };
}
