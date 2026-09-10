// Shell ↔ preview-bridge postMessage protocol. Both directions carry `__toyon: true` on the
// wire as a marker; the shapes below are the payloads.
//
// ShellToBridgeMsg is a plain union: the bridge accepts commands only from the shell's origin.
// BridgeToShellMsg is a zod schema: the preview page is untrusted, so the shell validates before
// dispatching (and the schema strips the marker and anything else unexpected).

import { z } from "zod";
import type { PickMeta } from "./events.ts";
import { pickMetaSchema } from "./pick.ts";

declare global {
  interface Window {
    /** the shell marks its own document. A shell framed as a preview (toyon inside toyon) has the
     * same chord table as the one framing it, so the injected bridge leaves the keyboard alone
     * instead of forwarding every chord out to the outer shell. */
    __toyonShell?: boolean;
  }
}

export type ShellToBridgeMsg =
  | { type: "reload" }
  | { type: "navigate"; path: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "pick-start" }
  | { type: "pick-cancel" }
  /** the modifiers that steer the picker's click: alt swaps the verb from chat to source, shift
   * swaps which source. Forwarded because the chord that arms the picker leaves focus in the
   * shell, where a keydown never reaches the frame at all. */
  | { type: "pick-mods"; alt: boolean; shift: boolean }
  /** ranges: changed line spans (post-offset numbering); null/absent = whole file */
  | { type: "highlight-file"; path: string; ranges?: Array<[number, number]> | null }
  | { type: "highlight-selector"; selector: string; label?: string }
  /** A design token has no selector to look for, so it is found by what it computes to. `props` are
   * already in the browser's own serialisation, read off the sample the pane is rendering, so the
   * bridge compares strings and needs no colour parsing: it has 600 bytes of budget, not a parser.
   * `all` for a type token, where the face, the size and the leading only mean anything together;
   * `any` for a colour, which can land on a background, a border or the text itself. */
  | { type: "highlight-computed"; props: Array<[string, string]>; match: "all" | "any"; label?: string }
  | { type: "highlight-clear" }
  /** overlay colors follow the shell theme */
  | { type: "theme"; accent: string; accentFg: string }
  /** zen hands the keyboard to the app under test: while on, the bridge takes only the chord
   * that leaves zen and lets everything else (Escape included) reach the page */
  | { type: "zen"; on: boolean };

const range = z.tuple([z.number(), z.number()]);

/** a picked element: the PickMeta that travels with the chat message, plus display-only context */
export const pickedElementSchema = pickMetaSchema.extend({
  classes: z.string(),
  text: z.string(),
  html: z.string(),
  route: z.string(),
});
export type PickedElement = z.infer<typeof pickedElementSchema>;

export const bridgeToShellSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("loaded"), url: z.string(), title: z.string() }),
  z.object({ type: z.literal("navigated"), url: z.string() }),
  z.object({ type: z.literal("hmr") }),
  z.object({
    type: z.literal("page-error"),
    message: z.string(),
    source: z.string().optional(),
    line: z.number().optional(),
  }),
  /** `verb` is where the click sends it: the chat, or a source file. `site` is which source, and
   * the bridge has already resolved the fallback: it names one the message actually carries.
   * Defaulted rather than required, so a page still holding an older bridge keeps working. */
  pickedElementSchema.extend({
    type: z.literal("picked"),
    verb: z.enum(["chat", "code"]).default("chat"),
    site: z.enum(["call", "source"]).default("source"),
  }),
  z.object({ type: z.literal("pick-cancel") }),
  z.object({
    type: z.literal("highlight-miss"),
    path: z.string(),
    fileMatched: z.number(),
    withSource: z.number(),
    ranges: z.array(range).nullable(),
  }),
  /** a file drag is over the preview: the shell's window sees no dragover while the pointer is
   * inside a frame, and would otherwise still believe the drag is wherever it saw it last */
  z.object({ type: z.literal("drag-files") }),
  /** a file dropped on the preview that the page itself did not take. The bridge swallowed it:
   * left alone the frame navigates to the file and the running app is gone */
  z.object({ type: z.literal("drop-files") }),
  /** a Toyon chord pressed while the preview had focus; the shell replays it as a keydown */
  z.object({
    type: z.literal("key"),
    key: z.string(),
    meta: z.boolean(),
    ctrl: z.boolean().optional(),
    shift: z.boolean().optional(),
    alt: z.boolean().optional(),
  }),
]);
export type BridgeToShellMsg = z.infer<typeof bridgeToShellSchema>;

export function parseBridgeMsg(raw: unknown): BridgeToShellMsg | null {
  const r = bridgeToShellSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** the chat-message subset of a picked element */
export function pickMetaOf(p: PickedElement): PickMeta {
  return {
    component: p.component,
    file: p.file,
    line: p.line,
    callFile: p.callFile,
    callLine: p.callLine,
    tag: p.tag,
    selector: p.selector,
  };
}
