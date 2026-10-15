/** The what's-new chip in the bar: the word on it and its tip, for the first page after Toyon
 * updated itself from `from` to `to`. "Here" rather than "this browser": the same page runs in a
 * browser tab and in the installed app, and the version remembered is this one's either way. */
export function notesOfferText(from: string, to: string): { word: string; text: string } {
  return {
    word: `what's new in ${to}`,
    text: `Toyon updated from ${from} to ${to} since you last opened it here. Press to read what changed`,
  };
}

/** what the release notes view says while the document is not there to read: the daemon is still
 * being asked, or it has none. Once the notes are read the document speaks for itself. */
export function notesLead(version: string, notes: "reading" | "missing"): string {
  if (notes === "reading") return "Reading the release notes";
  return `No release notes could be read from Toyon ${version}.`;
}
