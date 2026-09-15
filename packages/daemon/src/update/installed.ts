/** The version a package.json names, or null when it cannot be read: missing, or caught
 * half-written by an install that is still running. */
export async function readVersion(path: string): Promise<string | null> {
  try {
    const json = (await Bun.file(path).json()) as { version?: unknown };
    return typeof json.version === "string" ? json.version : null;
  } catch {
    // unreadable means not known yet; the next read is a page load or a minute away
    return null;
  }
}
