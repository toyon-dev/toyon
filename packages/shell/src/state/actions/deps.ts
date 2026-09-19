import { isInstalledApp } from "../../surfaces/util.ts";
import type { MenuItem } from "../../ui/menu.ts";
import type { DaemonSocket } from "../../ws.ts";
import type { Action } from "../store.ts";

/** what every item builder needs to act: the socket to send on and the reducer to tell */
export type Deps = { sock: DaemonSocket | null; dispatch: (a: Action) => void };

/** a page opened outside the shell. From a browser tab that is another tab; the installed app has
 * no tabs, and a window opened from it lands in the system browser, so the label says where it
 * goes rather than naming chrome the app does not have. */
export const openOutItem = (url: string): MenuItem => ({
  id: "open-out",
  label: isInstalledApp() ? "open in the browser" : "open in a new tab",
  onClick: () => window.open(url, "_blank"),
});

/** best effort: a denied clipboard permission is not worth a word over text you can read */
export const copyText = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

/** a clipboard write whose bytes are still on their way. Handed over as a promise rather than
 * awaited first: Safari honours a write only inside the click that asked for it, and a fetch or a
 * re-encode outlives that click. Browsers without ClipboardItem wait for the bytes and hope. */
function copyLater(type: "text/plain" | "image/png", bytes: Promise<Blob>) {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  if (typeof ClipboardItem === "undefined" || !clipboard.write) {
    if (type === "text/plain") void bytes.then((b) => b.text()).then(copyText, () => {});
    return;
  }
  void clipboard.write([new ClipboardItem({ [type]: bytes })]).catch(() => {});
}

/** the text at `href`, which is where the daemon keeps a paste once it has been sent */
export const copyTextFrom = (href: string) =>
  copyLater(
    "text/plain",
    fetch(href).then((r) => r.blob()),
  );

/** the picture at `src` as a PNG, the one image type every clipboard takes; a JPEG is redrawn */
export const copyImage = (src: string) => copyLater("image/png", pngOf(src));

async function pngOf(src: string): Promise<Blob> {
  const blob = await (await fetch(src)).blob();
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode image"))), "image/png"),
    );
  } finally {
    bitmap.close();
  }
}
