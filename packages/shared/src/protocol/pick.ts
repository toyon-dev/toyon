// The shape of a picked element's identity, which both protocols need.
//
// Its own module so bridge.ts, whose parseBridgeMsg is a value import in the browser bundle, never
// reaches into ws.ts and pulls every client-message schema in with it.

import { z } from "zod";

export const pickMetaSchema = z.object({
  component: z.string().nullable(),
  /** the JSX the element itself was rendered from */
  file: z.string().nullable(),
  line: z.number().nullable(),
  /** where the component holding it is written. Picking a control in a design system lands on the
   * shared component (`<button>` inside ui/Button.tsx) and almost never on the file worth editing,
   * which is the surface that writes `<Button>`: that line is this. Null when the element's own JSX
   * is already in the file that renders it. Defaulted, so a page still holding an older bridge
   * parses. */
  callFile: z.string().nullable().default(null),
  callLine: z.number().nullable().default(null),
  tag: z.string(),
  selector: z.string(),
});
