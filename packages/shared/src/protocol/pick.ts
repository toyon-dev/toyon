// The shape of a picked element's identity, which both protocols need.
//
// Its own module because the two that want it sit on opposite sides of the app: ws.ts bounds it
// on the chat frames that carry a pick, and bridge.ts extends it into what the preview posts
// back. Either importing the other drags a wall of schemas across that line, and the shell pays
// for it: parseBridgeMsg is a value import, so bridge.ts reaching into ws.ts put every
// client-message schema in the browser bundle for a validator that wanted five fields.

import { z } from "zod";

export const pickMetaSchema = z.object({
  component: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  tag: z.string(),
  selector: z.string(),
});
