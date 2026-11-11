// Monaco's menus, drawn as the shell's.
//
// Monaco draws a menu inside the editor's own DOM, fixed to the window with a z-index. A pane
// isolates, so that z-index counts inside the pane alone, and a menu that reaches past the pane is
// under whatever is drawn after it: a dock's rows paint through it. Every menu Monaco asks for
// (the editor's own, sticky scroll's, an inlay hint's, a deleted hunk's) goes through one service,
// and that service hands a list of actions to a handler that draws them. The handler here opens
// the shell's menu instead: the top layer, the shell's rows and keys, one menu at a time. Monaco
// still decides what is on the list and what each row runs.

import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import {
  type Action,
  ContextMenuService,
  type MenuDelegate,
} from "monaco-editor/platform/contextview/browser/contextMenuService.js";
import { SyncDescriptor } from "monaco-editor/platform/instantiation/common/descriptors.js";
import { type MenuEntry, menuStore, SEP, tidy } from "../../ui/menu.ts";

/** the id Monaco gives the rule between two groups */
const SEPARATOR = "vs.actions.separator";

class ShellMenus extends ContextMenuService {
  protected override get contextMenuHandler() {
    return { showContextMenu: (delegate: MenuDelegate) => this.show(delegate) };
  }

  private show(delegate: MenuDelegate) {
    // a press on a row moves focus to the row; the action is meant for whatever had it before
    const focused = document.activeElement as HTMLElement | null;
    let ran = false;
    const run = (action: Action) => {
      ran = true;
      menuStore.close();
      focused?.focus();
      const context = delegate.getActionsContext ? delegate.getActionsContext() : null;
      (async () => (delegate.actionRunner ? delegate.actionRunner.run(action, context) : action.run(context)))().catch(
        (e) => this.notificationService.error(e),
      );
    };
    const keyOf = (action: Action) =>
      (delegate.getKeyBinding
        ? delegate.getKeyBinding(action)
        : this.keybindingService.lookupKeybinding(action.id)
      )?.getLabel();
    // The shell's menu is one list, so a submenu's rows stand in it as a group of their own. A row
    // Monaco has switched off is left out: a row that is off says why under its label, and Monaco
    // gives no reason to print.
    const rows = (actions: readonly Action[]): MenuEntry[] =>
      actions.flatMap((action): MenuEntry[] => {
        if (action.id === SEPARATOR) return [SEP];
        if (action.actions) return [SEP, ...rows(action.actions), SEP];
        if (!action.enabled) return [];
        const key = keyOf(action);
        return [
          {
            id: action.id,
            label: action.label,
            ...(key ? { key } : {}),
            ...(action.checked ? { checked: true } : {}),
            onClick: () => run(action),
          },
        ];
      });
    const items = tidy(rows(delegate.getActions()));
    if (items.length === 0) {
      delegate.onHide?.(true);
      return;
    }

    const anchor = delegate.getAnchor();
    // the editor it was asked in: the line under the pointer is redrawn as the caret lands on it,
    // and a menu about an element that left the page closes
    const about =
      anchor instanceof HTMLElement ? anchor : (delegate.domForShadowRoot ?? focused ?? document.documentElement);
    const point = (a: Exclude<typeof anchor, HTMLElement>) =>
      "posx" in a ? { x: a.posx, y: a.posy } : { x: a.x, y: a.y + (a.height ?? 0) };
    const where = anchor instanceof HTMLElement ? { anchor: anchor.getBoundingClientRect() } : { at: point(anchor) };
    menuStore.open({ items, owner: "editor", target: about, ...where });

    // Monaco scrolls by moving its lines, which no scroll event reports, and the menu would stay
    // where the code it was asked about no longer is
    const close = () => menuStore.close();
    about.addEventListener("wheel", close, { passive: true });
    const id = menuStore.get()?.id;
    const stop = menuStore.subscribe(() => {
      if (menuStore.get()?.id === id) return;
      stop();
      about.removeEventListener("wheel", close);
      delegate.onHide?.(!ran);
    });
  }
}

/** Before anything else asks Monaco for a service: it takes its replacements once, as the first
 * service is made, and drops any that come later without a word. */
export function registerMenus() {
  StandaloneServices.initialize({ contextMenuService: new SyncDescriptor(ShellMenus) });
}
