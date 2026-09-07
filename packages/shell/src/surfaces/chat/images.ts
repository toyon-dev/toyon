// Images on their way into a message: pulled out of a paste or drop, downscaled to the models'
// long-edge ceiling, and re-encoded when the original is a format or size the daemon refuses.

import { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE, IMAGE_MIME_TYPES, type ImageMimeType } from "@toyon/shared";
import type { ChatItem, PendingImage } from "../../state/store.ts";

const ACCEPTED = new Set<string>(IMAGE_MIME_TYPES);
/** past this a "text" file is not something anyone means to paste into a message */
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/** the image files in a paste or drop, in the order the OS lists them */
export function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  // Safari fills files but not items for some drops
  if (out.length === 0) for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith("image/")) out.push(f);
  return out;
}

/** everything else the OS handed over: a file copied in Finder or dragged in arrives here, and a
 * text one becomes a paste chip. The browser never exposes its path, so a file that happens to
 * live in the worktree still cannot become an @ reference; its contents travel instead. */
export function otherFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file" || item.type.startsWith("image/")) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  if (out.length === 0) for (const f of Array.from(dt.files ?? [])) if (!f.type.startsWith("image/")) out.push(f);
  return out;
}

/** a file's text, or null when it is not text at all. Decoded strictly, so a binary comes back
 * null rather than as a screen of replacement characters. */
export async function readText(file: File): Promise<string | null> {
  if (file.size > MAX_TEXT_FILE_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return null;
  }
}

/** the number the daemon will give the next image sent from this worktree: the count is per
 * session, so the composer's chips can show it before the send */
export function nextImageNumber(chat: ChatItem[]): number {
  let n = 0;
  for (const item of chat) if (item.kind === "user") for (const img of item.images ?? []) n = Math.max(n, img.n);
  return n + 1;
}

/** the same for pastes, which the daemon numbers on their own sequence */
export function nextPasteNumber(chat: ChatItem[]): number {
  let n = 0;
  for (const item of chat) if (item.kind === "user") for (const p of item.pastes ?? []) n = Math.max(n, p.n);
  return n + 1;
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name || "image"}: not a readable image`);
  }
}

function toBase64(bytes: ArrayBuffer): string {
  let s = "";
  const u = new Uint8Array(bytes);
  // String.fromCharCode over the whole buffer overflows the argument list on large images
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

function encode(bitmap: ImageBitmap, scale: number, mime: ImageMimeType): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode image"))), mime, 0.9),
  );
}

let keySeq = 0;

/** a file as the daemon wants it: within IMAGE_MAX_EDGE and IMAGE_MAX_BYTES, in a format the
 * models accept. Originals that already qualify go through untouched (a re-encode of a
 * screenshot only loses quality); the rest are drawn down and saved as PNG, or JPEG when the
 * source was one, since a photo re-encoded as PNG balloons. */
export async function prepareImage(file: File): Promise<PendingImage> {
  const bitmap = await decode(file);
  try {
    const edge = Math.max(bitmap.width, bitmap.height);
    let blob: Blob = file;
    let mimeType = file.type;
    let width = bitmap.width;
    let height = bitmap.height;
    if (!ACCEPTED.has(mimeType) || edge > IMAGE_MAX_EDGE || file.size > IMAGE_MAX_BYTES) {
      const target: ImageMimeType = mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
      let scale = Math.min(1, IMAGE_MAX_EDGE / edge);
      blob = await encode(bitmap, scale, target);
      // a huge PNG can still be over the byte cap at the edge ceiling; step down until it fits
      while (blob.size > IMAGE_MAX_BYTES && scale > 0.1) {
        scale *= 0.7;
        blob = await encode(bitmap, scale, target);
      }
      if (blob.size > IMAGE_MAX_BYTES) throw new Error(`${file.name || "image"}: too large even after downscaling`);
      mimeType = target;
      width = Math.max(1, Math.round(bitmap.width * scale));
      height = Math.max(1, Math.round(bitmap.height * scale));
    }
    return {
      key: `img${++keySeq}`,
      name: file.name || `pasted.${mimeType === "image/jpeg" ? "jpg" : "png"}`,
      mimeType: mimeType as ImageMimeType,
      data: toBase64(await blob.arrayBuffer()),
      width,
      height,
      bytes: blob.size,
    };
  } finally {
    bitmap.close();
  }
}

export function dataUrl(img: Pick<PendingImage, "mimeType" | "data">): string {
  return `data:${img.mimeType};base64,${img.data}`;
}

export function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
