// What a pasted block looks like to the person and to the model. Both packages derive the same
// numbers from the same text: the shell to label the chip before sending, the daemon to build the
// PasteRef it stores, so a chip and its transcript entry can never disagree.

import { PASTE_MIN_CHARS, PASTE_MIN_LINES } from "./protocol/limits.ts";

/** how many characters of the first line the chip and the prompt header carry */
const PREVIEW_CHARS = 80;

export function pasteSummary(text: string): { chars: number; lines: number; preview: string } {
  const lines = text.split("\n");
  const first = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  return { chars: text.length, lines: lines.length, preview: first.slice(0, PREVIEW_CHARS) };
}

/** a paste the composer collapses into a chip rather than dropping into the textarea */
export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_MIN_CHARS || text.split("\n").length >= PASTE_MIN_LINES;
}

// A copied terminal buffer brings its colours along: noise to the model, garbage in the chip
// preview. CSI (cursor and colour) and OSC (title, hyperlink) are all a selection can carry.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the thing matched
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
