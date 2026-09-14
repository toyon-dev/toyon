// The parts of the wire protocol that carry no zod: the version, the bounds, and the one guard
// that is a comparison rather than a schema.
//
// Kept off ws.ts: a top-level `z.object(...)` is a call no bundler shakes out, so a bound imported
// through ws.ts drags all of zod into the shell. ws.ts imports them back, so the schemas stay the
// source of truth for the shapes they bound.

import type { FileServerMsg, ServerMsg, TermServerMsg } from "./ws.ts";

/**
 * Bump when a ServerMsg/ClientMsg shape changes incompatibly; the shell compares it on hello and
 * stops talking rather than misreading frames.
 *
 * A *new* ClientMsg kind counts, however additive it looks: the shell ships from dist and the
 * daemon from source, so a reloaded tab routinely talks to a daemon that has not restarted, and
 * an unknown `t` there is a zod failure the person reads as a wall of discriminator values. The
 * same goes for a new required field on an existing kind.
 */
export const PROTOCOL_VERSION = 44;

/** the largest file the editor opens or saves, in characters (a read counts bytes, which is never
 * fewer). A larger one opens read-only with nothing in it, and a save of more is refused before any
 * handler runs, so the shell never sends one: that refusal could not say which write it was. */
export const FILE_MAX_CHARS = 5_000_000;

/** image formats the models accept; the shell re-encodes anything else (and anything too large) */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
/** the models' long-edge ceiling; the shell downscales to it before sending */
export const IMAGE_MAX_EDGE = 2576;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** when a paste collapses into a chip instead of filling the textarea. Either bound trips it: a
 * wall of prose has few lines, a stack trace has short ones. */
export const PASTE_MIN_CHARS = 1200;
export const PASTE_MIN_LINES = 10;
export const PASTE_MAX_CHARS = 100_000;

/** the terminal frames, which go to the terminal bus rather than through the store. The type-only
 * import above erases, so this file reaches nothing at runtime. */
export function isTermMsg(m: ServerMsg): m is TermServerMsg {
  return m.t === "term-data" || m.t === "term-snapshot" || m.t === "term-exit";
}

/** the editor's file answers, which go to the shell's file sync rather than through the store */
export function isFileMsg(m: ServerMsg): m is FileServerMsg {
  return m.t === "file-read" || m.t === "file-written";
}
