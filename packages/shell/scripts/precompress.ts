// A brotli and a gzip sibling beside every hashed asset the build writes, so the daemon answers a
// browser that takes one straight off disk (daemon server/encoding.ts picks the sibling) and
// compresses nothing per request. Both, because browsers offer brotli only on a secure origin:
// the phone over https takes it, the desk on http://127.0.0.1 takes gzip.
//
// Quality 9 for brotli, measured on one build of 99 files: under half a second, where quality 11
// takes thirty for a tenth fewer bytes, on every build people iterate with and every land.

import { statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Plugin } from "vite";

// the callback forms, which run on the threadpool: the whole build's files compress side by
// side, where the sync forms would take them one after another on the main thread
const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** what compresses: text by extension. Fonts and images are already packed. */
export const COMPRESS_EXT = /\.(js|css|svg|json|wasm|txt)$/;
/** under this a sibling saves less than the stat that finds it */
export const COMPRESS_MIN = 1024;
/** a sibling that is not at least this much smaller is not written: a browser would pay the
 * decode for nothing, and the server would stat it on every request */
const WORTH = 0.9;

/** Write `${file}.br` and `${file}.gz` beside a built asset, and answer each sibling's size, or
 * null where none was written: a small file, or one that barely shrinks. Each is written under a
 * temporary name and renamed into place, so a daemon serving the directory never reads a
 * half-written sibling; an existing one is always rewritten, since an interrupted build may have
 * left a short one under a valid hashed name. */
export async function compressFile(file: string): Promise<{ br: number | null; gz: number | null }> {
  const buf = await readFile(file);
  if (buf.byteLength < COMPRESS_MIN) return { br: null, gz: null };
  const [br, gzip] = await Promise.all([
    brotli(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 9,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_SIZE_HINT]: buf.byteLength,
      },
    }),
    gz(buf, { level: 9 }),
  ]);
  return {
    br: await place(`${file}.br`, br, buf.byteLength),
    gz: await place(`${file}.gz`, gzip, buf.byteLength),
  };
}

async function place(path: string, bytes: Buffer, original: number): Promise<number | null> {
  if (bytes.byteLength > original * WORTH) return null;
  // named for this process: two builds of one tree emit the same hashed names, and a shared
  // temporary name would let the slower one rename what the faster one already moved
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
  return bytes.byteLength;
}

/** The plugin: once Vite has written a bundle, every asset it emitted this build gets its
 * siblings. Only this build's: the dist keeps older chunks for open tabs, and their siblings are
 * already beside them. `apply: "build"` keeps it out of the dev server, which serves nothing from
 * disk. */
export function precompress(): Plugin {
  return {
    name: "toyon-precompress",
    apply: "build",
    async writeBundle(options, bundle) {
      const dir = options.dir;
      if (!dir) return;
      const names = Object.keys(bundle).filter((name) => COMPRESS_EXT.test(name));
      const started = performance.now();
      const sizes = await Promise.all(names.map((name) => compressFile(join(dir, name))));
      const written = sizes.filter((s) => s.br !== null || s.gz !== null).length;
      const ms = Math.round(performance.now() - started);
      this.info(`compressed ${written} of ${names.length} assets in ${ms} ms`);
    },
  };
}

/** the size of a sibling, for the size report; null when none was written */
export function siblingSize(file: string, ext: "br" | "gz"): number | null {
  try {
    return statSync(`${file}.${ext}`).size;
  } catch {
    return null;
  }
}
