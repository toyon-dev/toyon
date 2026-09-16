// Monaco ships these modules without types. Only what tsx.ts reads is declared.

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
  export class FormatAdapter implements monaco.languages.DocumentRangeFormattingEditProvider {
    constructor(worker: Worker);
    provideDocumentRangeFormattingEdits: monaco.languages.DocumentRangeFormattingEditProvider["provideDocumentRangeFormattingEdits"];
  }
  export class FormatOnTypeAdapter implements monaco.languages.OnTypeFormattingEditProvider {
    constructor(worker: Worker);
    autoFormatTriggerCharacters: string[];
    provideOnTypeFormattingEdits: monaco.languages.OnTypeFormattingEditProvider["provideOnTypeFormattingEdits"];
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
