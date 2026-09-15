import { chord } from "../../surfaces/util.ts";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import { copyText } from "./deps.ts";

/** the preview as a page: the same page in a real tab, its address as text, and a reload. The
 * nav cluster's right-click; the address field itself keeps the browser's menu, being an input. */
export function previewItems(url: string | undefined, ui: { reload: () => void }): MenuEntry[] {
  const page: MenuItem[] = [];
  if (url) {
    page.push({ id: "open-tab", label: "open in a new tab", onClick: () => window.open(url, "_blank") });
    page.push({ id: "copy-url", label: "copy URL", onClick: () => copyText(url) });
  }
  return grouped([page, [{ id: "reload", label: "reload preview", key: chord("reload"), onClick: ui.reload }]]);
}
