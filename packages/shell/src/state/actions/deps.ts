import type { DaemonSocket } from "../../ws.ts";
import type { Action } from "../store.ts";

/** what every item builder needs to act: the socket to send on and the reducer to tell */
export type Deps = { sock: DaemonSocket | null; dispatch: (a: Action) => void };

/** best effort: a denied clipboard permission is not worth a word over text you can read */
export const copyText = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
