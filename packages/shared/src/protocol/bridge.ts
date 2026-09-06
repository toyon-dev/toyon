// Shell ↔ preview-bridge postMessage protocol. Both directions carry `__toyon: true` on the
// wire as a marker; the shapes below are the payloads.
//
// ShellToBridgeMsg is a plain union: the bridge accepts commands only from the shell's origin.
// BridgeToShellMsg is a zod schema: the preview page is untrusted, so the shell validates before
// dispatching (and the schema strips the marker and anything else unexpected).

import { z } from "zod";
import type { PickMeta } from "./events.ts";

export type ShellToBridgeMsg =
  | { type: "reload" }
  | { type: "navigate"; path: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "pick-start" }
  | { type: "pick-cancel" }
  /** ranges: changed line spans (post-offset numbering); null/absent = whole file */
  | { type: "highlight-file"; path: string; ranges?: Array<[number, number]> | null }
  | { type: "highlight-selector"; selector: string; label?: string }
  | { type: "highlight-clear" }
  /** overlay colors follow the shell theme */
  | { type: "theme"; accent: string; accentFg: string };

const range = z.tuple([z.number(), z.number()]);

/** a picked element: the PickMeta that travels with the chat message, plus display-only context */
export const pickedElementSchema = z.object({
  component: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  tag: z.string(),
  selector: z.string(),
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
  pickedElementSchema.extend({ type: z.literal("picked") }),
  z.object({ type: z.literal("pick-cancel") }),
  z.object({
    type: z.literal("highlight-miss"),
    path: z.string(),
    fileMatched: z.number(),
    withSource: z.number(),
    ranges: z.array(range).nullable(),
  }),
  /** an Toyon chord pressed while the preview had focus; the shell replays it as a keydown */
  z.object({ type: z.literal("key"), key: z.string(), meta: z.literal(true), shift: z.boolean().optional() }),
]);
export type BridgeToShellMsg = z.infer<typeof bridgeToShellSchema>;

export function parseBridgeMsg(raw: unknown): BridgeToShellMsg | null {
  const r = bridgeToShellSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** the chat-message subset of a picked element */
export function pickMetaOf(p: PickedElement): PickMeta {
  return { component: p.component, file: p.file, line: p.line, tag: p.tag, selector: p.selector };
}
