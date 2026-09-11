// What the editor may do with a file's bytes. Text is UTF-8 or it is not text: a lossy decode hands
// the editor U+FFFD where the file has bytes, and the first save writes those back over the file.

/** names these exact bytes; a write names it back as the version it expects to replace */
export function versionOf(bytes: Uint8Array): string {
  return Bun.hash(bytes).toString(36);
}

export function hasBom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** the text the editor shows, or null for bytes it cannot save back unchanged: a NUL early on, or
 * anything that is not valid UTF-8. A BOM is not part of the text (the decoder drops it); a write
 * puts it back when the file had one. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // a fatal decoder throws exactly when the bytes are not UTF-8, which is the answer
    return null;
  }
}

export function encodeText(text: string, bom: boolean): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

/** a side git printed rather than one read as bytes: binary when a NUL shows early */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes("\0");
}
