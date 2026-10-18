// What the composer's plan row calls the plan. The file is the agent's, named by it (Claude makes a
// slug of the prompt's first words and a random pair), so the path says little; the plan's own
// first heading is what a person knows it by, and the agent keeps that heading current as it edits.

/** the first heading in the markdown, or null when it opens with none */
export function planTitle(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1]!;
    // a heading is a title only at the top: past the first prose the plan has chosen to have none
    if (line.trim() && !line.startsWith("<!--")) return null;
  }
  return null;
}

/** a plan file with no heading goes by its name, without the folder and the extension */
export function planName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}
