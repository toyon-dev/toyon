import { chord } from "../../surfaces/util.ts";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import { copyText, openOutItem } from "./deps.ts";

/** the preview as a page: the same page outside the shell, its address as text, and a reload. The
 * nav cluster's right-click; the address field itself keeps the browser's menu, being an input. */
export function previewItems(url: string | undefined, ui: { reload: () => void }): MenuEntry[] {
  const page: MenuItem[] = [];
  if (url) {
    page.push(openOutItem(url));
    page.push({ id: "copy-url", label: "copy URL", onClick: () => copyText(url) });
  }
  return grouped([page, [{ id: "reload", label: "reload preview", key: chord("reload"), onClick: ui.reload }]]);
}
