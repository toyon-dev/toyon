// What a message carries besides its words, as one ordered list: the kinds, how many of each one
// message holds, and how each is numbered and named. Zod-free like limits.ts, so the shell can
// bound and label chips without pulling the schemas in; ws.ts bounds the wire with these numbers.

export const ATTACHMENT_KINDS = ["image", "paste", "file", "pick"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** how many of each kind one message holds. The kind decides how a thing travels, never its size:
 * an image and a file are uploaded when they are attached and the message names them by id, while
 * a paste and a picked element ride in the frame. */
export const ATTACHMENT_LIMITS: Readonly<Record<AttachmentKind, number>> = { image: 6, paste: 4, file: 8, pick: 8 };
export const ATTACHMENTS_PER_MESSAGE = ATTACHMENT_KINDS.reduce((sum, k) => sum + ATTACHMENT_LIMITS[k], 0);

/** what a person calls one of a kind, in a sentence */
const KIND_NOUN: Readonly<Record<AttachmentKind, string>> = {
  image: "image",
  paste: "paste",
  file: "file",
  pick: "element",
};

const KIND_LABEL = { image: "Image", paste: "Pasted text" } as const;

/** the name an image or a paste goes by on its chip and in the prompt, so the two always agree. Only
 * these are named by number, since nothing else names them: a screenshot is `pasted.png` and a paste
 * has no name at all, where a picked element is its component and file. */
export const attachmentLabel = (kind: keyof typeof KIND_LABEL, n: number): string => `${KIND_LABEL[kind]} ${n}`;

/** what a message holding too many of `kind` is told: by the composer before it sends, and by the
 * schema if one arrives anyway */
export const limitMessage = (kind: AttachmentKind): string =>
  `at most ${ATTACHMENT_LIMITS[kind]} ${KIND_NOUN[kind]}s per message`;

type Kinded = { readonly kind: AttachmentKind };

const countOf = (list: readonly Kinded[], kind: AttachmentKind) => list.filter((a) => a.kind === kind).length;

/** how many more of `kind` fit beside what `list` already holds */
export const roomFor = (list: readonly Kinded[], kind: AttachmentKind): number =>
  Math.max(0, ATTACHMENT_LIMITS[kind] - countOf(list, kind));

/** the first kind `list` holds too many of, or null when it fits */
export const overLimit = (list: readonly Kinded[]): AttachmentKind | null =>
  ATTACHMENT_KINDS.find((k) => countOf(list, k) > ATTACHMENT_LIMITS[k]) ?? null;

/** the number the next attachment of each kind takes in a session. Numbers run per kind across the
 * whole session rather than per message: the model keeps earlier attachments in context, so
 * "Image 2" two turns later has to mean the same image. */
export function nextNumbers(
  sent: Iterable<readonly (Kinded & { readonly n: number })[] | undefined>,
): Record<AttachmentKind, number> {
  const next: Record<AttachmentKind, number> = { image: 1, paste: 1, file: 1, pick: 1 };
  for (const list of sent) for (const a of list ?? []) next[a.kind] = Math.max(next[a.kind], a.n + 1);
  return next;
}

/** each of `items` with the number it will take, counting each kind on from `next` in the order the
 * items come: what a waiting chip shows before the daemon has numbered it */
export function numbered<T extends Kinded>(
  items: readonly T[],
  next: Readonly<Record<AttachmentKind, number>>,
): Array<[T, number]> {
  const at = { ...next };
  return items.map((item) => [item, at[item.kind]++]);
}

/** `next` once `items` have taken their numbers: where the count stands after a message that has
 * not been recorded yet, a queued one, so what follows it is numbered as it will be sent */
export function numbersAfter(
  next: Readonly<Record<AttachmentKind, number>>,
  items: readonly Kinded[],
): Record<AttachmentKind, number> {
  const at = { ...next };
  for (const item of items) at[item.kind]++;
  return at;
}

/** a size the way a chip and a caption both say it */
export function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** what an upload answers with: the id a message names the bytes by, how many there were, and
 * whether they read as text */
export interface Uploaded {
  upload: string;
  bytes: number;
  text: boolean;
}

/** the box an ask card's attachments wait in: the card's own, apart from the composer's, since a
 * drop on the card goes with the answer and not with the message being written behind it */
export const cardBox = (askId: string): string => `card:${askId}`;
