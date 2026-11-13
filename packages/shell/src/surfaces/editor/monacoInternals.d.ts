// Monaco ships these modules without types. Only what tsx.ts and monacoMenu.ts read is declared.

declare module "monaco-editor/editor/standalone/browser/standaloneServices.js" {
  export const StandaloneServices: {
    /** services by name, standing in for Monaco's own; taken once, before the first is made */
    initialize(overrides: Record<string, unknown>): unknown;
  };
}

declare module "monaco-editor/platform/instantiation/common/descriptors.js" {
  /** a service Monaco makes itself when it is first asked for, handing it the services it names */
  export class SyncDescriptor<T> {
    // biome-ignore lint/suspicious/noExplicitAny: the arguments are the services Monaco injects
    constructor(ctor: new (...args: any[]) => T);
  }
}

declare module "monaco-editor/platform/contextview/browser/contextMenuService.js" {
  type Keybinding = { getLabel(): string | null };
  /** one row of a menu. The rule between two groups is an action too, under an id of its own, and
   * a submenu is one that holds `actions`. */
  export type Action = {
    id: string;
    label: string;
    enabled: boolean;
    checked?: boolean;
    actions?: readonly Action[];
    run(context?: unknown): unknown;
  };
  /** what asks for a menu: the rows, where to put it, and what to tell when it has gone */
  export type MenuDelegate = {
    /** an element to hang under, the mouse event that asked, or a point (a box, to open under) */
    getAnchor(): HTMLElement | { posx: number; posy: number } | { x: number; y: number; height?: number };
    getActions(): readonly Action[];
    getActionsContext?(): unknown;
    getKeyBinding?(action: Action): Keybinding | undefined;
    actionRunner?: { run(action: Action, context?: unknown): Promise<void> };
    /** the editor the menu was asked in, where Monaco would have drawn it */
    domForShadowRoot?: HTMLElement;
    onHide?(cancelled: boolean): void;
  };
  export class ContextMenuService {
    protected readonly keybindingService: { lookupKeybinding(id: string): Keybinding | undefined };
    protected readonly notificationService: { error(e: unknown): void };
    /** what draws the menu, once the service has worked out its rows */
    protected get contextMenuHandler(): { showContextMenu(delegate: MenuDelegate): void };
  }
}

declare module "monaco-editor/languages/definitions/typescript/typescript.js" {
  import type * as monaco from "monaco-editor";
  export const conf: monaco.languages.LanguageConfiguration;
}

declare module "monaco-editor/languages/features/typescript/tsMode.js" {
  import type * as monaco from "monaco-editor";

  type Worker = (...uris: monaco.Uri[]) => Promise<unknown>;
  type Defaults = typeof monaco.typescript.typescriptDefaults;
  export class LibFiles {
    constructor(worker: Worker);
  }
  export class SuggestAdapter implements monaco.languages.CompletionItemProvider {
    constructor(worker: Worker);
    provideCompletionItems: monaco.languages.CompletionItemProvider["provideCompletionItems"];
  }
  export class SignatureHelpAdapter implements monaco.languages.SignatureHelpProvider {
    constructor(worker: Worker);
    provideSignatureHelp: monaco.languages.SignatureHelpProvider["provideSignatureHelp"];
  }
  export class QuickInfoAdapter implements monaco.languages.HoverProvider {
    constructor(worker: Worker);
    provideHover: monaco.languages.HoverProvider["provideHover"];
  }
  export class DocumentHighlightAdapter implements monaco.languages.DocumentHighlightProvider {
    constructor(worker: Worker);
    provideDocumentHighlights: monaco.languages.DocumentHighlightProvider["provideDocumentHighlights"];
  }
  export class DefinitionAdapter implements monaco.languages.DefinitionProvider {
    constructor(libFiles: LibFiles, worker: Worker);
    provideDefinition: monaco.languages.DefinitionProvider["provideDefinition"];
  }
  export class ReferenceAdapter implements monaco.languages.ReferenceProvider {
    constructor(libFiles: LibFiles, worker: Worker);
    provideReferences: monaco.languages.ReferenceProvider["provideReferences"];
  }
  export class OutlineAdapter implements monaco.languages.DocumentSymbolProvider {
    constructor(worker: Worker);
    provideDocumentSymbols: monaco.languages.DocumentSymbolProvider["provideDocumentSymbols"];
  }
  export class RenameAdapter implements monaco.languages.RenameProvider {
    constructor(libFiles: LibFiles, worker: Worker);
    provideRenameEdits: monaco.languages.RenameProvider["provideRenameEdits"];
  }
  export class CodeActionAdaptor implements monaco.languages.CodeActionProvider {
    constructor(worker: Worker);
    provideCodeActions: monaco.languages.CodeActionProvider["provideCodeActions"];
  }
  export class InlayHintsAdapter implements monaco.languages.InlayHintsProvider {
    constructor(worker: Worker);
    provideInlayHints: monaco.languages.InlayHintsProvider["provideInlayHints"];
  }
  export class DiagnosticsAdapter {
    constructor(libFiles: LibFiles, defaults: Defaults, languageId: string, worker: Worker);
  }
}
