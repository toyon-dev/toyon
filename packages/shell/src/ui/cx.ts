/** The class list of an element with the falsy parts left out: `cx("rail", pinned && "pinned")`.
 * What clsx does, in the one line of it this app uses; Button and Field build their classes the
 * same way, so a surface's conditional class reads like theirs. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
