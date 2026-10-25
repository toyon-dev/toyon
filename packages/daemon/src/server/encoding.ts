// What the shell's bytes go out as. The build writes a brotli and a gzip sibling beside every
// hashed asset worth it (shell/scripts/precompress.ts), so a request that takes one is answered
// from disk with no work; what is made per request (the hello, the page) is gzipped on the way
// out, since a phone on a cold link pays for every byte and the daemon's gzip of a hello is
// milliseconds.

import { promisify } from "node:util";
import { gzip } from "node:zlib";

export type Encoding = "br" | "gzip";

const gzipAsync = promisify(gzip);

/** the content encodings a request takes, read off accept-encoding: each token lowercased up to
 * its `;`, and a `q=0` refuses one. Null or empty takes none; `*` is not worth code, since every
 * browser names what it takes (Chrome sends `gzip, deflate, br, zstd`). */
export function acceptedEncodings(header: string | null): Set<Encoding> {
  const out = new Set<Encoding>();
  if (!header) return out;
  for (const part of header.split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    const coding = name.trim();
    if (coding !== "br" && coding !== "gzip") continue;
    const refused = params.some((p) => /^\s*q\s*=\s*0(\.0*)?\s*$/.test(p));
    if (!refused) out.add(coding);
  }
  return out;
}

/** The file to send for `file` and how it is encoded: the brotli sibling when taken, else the
 * gzip one, else the file itself. A sibling is taken only when it has bytes, the guard the
 * original gets: a build interrupted mid-write leaves a short or empty one under a valid name. */
export function pickSibling(file: string, accepted: Set<Encoding>): { path: string; encoding: Encoding | null } {
  const candidates: Array<[Encoding, string]> = [
    ["br", `${file}.br`],
    ["gzip", `${file}.gz`],
  ];
  for (const [encoding, path] of candidates) {
    if (accepted.has(encoding) && Bun.file(path).size > 0) return { path, encoding };
  }
  return { path: file, encoding: null };
}

/** under this a gzip buys nothing a packet does not already carry */
export const GZIP_MIN_BYTES = 1024;

/** `body` as the request takes it: gzipped when gzip is offered and the body is past a KB, with
 * `content-encoding` and `vary` saying so; else as it is. On the threadpool, not the loop: gzip
 * measures about 7 ms per MB of minified text here, which a hello with every row and theme in
 * it would have charged every socket on the daemon. Gzip only: browsers send `br` only over
 * https, and for a few KB a second path is not worth having. */
export async function encoded(req: Request, body: string, headers: Record<string, string>): Promise<Response> {
  const bytes = Buffer.from(body);
  if (bytes.byteLength < GZIP_MIN_BYTES || !acceptedEncodings(req.headers.get("accept-encoding")).has("gzip")) {
    return new Response(bytes, { headers });
  }
  return new Response(await gzipAsync(bytes), {
    headers: { ...headers, "content-encoding": "gzip", vary: "accept-encoding" },
  });
}
