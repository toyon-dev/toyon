// A .tsx file as a language of its own. Monaco files .ts and .tsx together as `typescript`, and a
// tokenizer is chosen by language alone, so one of the two would be read in the other's grammar.
// The price of a second language is that Monaco wires its TypeScript features (hover, completions,
// syntax errors) to `typescript` by name. The worker behind them reads any file it is handed, so
// the same adapters are registered here for `typescriptreact`, over the one worker `typescript` has.

import * as monaco from "monaco-editor";
import { conf } from "monaco-editor/languages/definitions/typescript/typescript.js";
import {
  CodeActionAdaptor,
  DefinitionAdapter,
  DiagnosticsAdapter,
  DocumentHighlightAdapter,
  FormatAdapter,
  FormatOnTypeAdapter,
  InlayHintsAdapter,
  LibFiles,
  OutlineAdapter,
  QuickInfoAdapter,
  ReferenceAdapter,
  RenameAdapter,
  SignatureHelpAdapter,
  SuggestAdapter,
} from "monaco-editor/languages/features/typescript/tsMode.js";

export const TSX = "typescriptreact";

/** the language a file opens as, where the extension alone would put it in the wrong one */
export function languageFor(path: string): string | undefined {
  return /\.tsx$/i.test(path) ? TSX : undefined;
}

export function registerTsx() {
  monaco.languages.register({ id: TSX, aliases: ["TypeScript React", "tsx"] });
  monaco.languages.setLanguageConfiguration(TSX, conf);
  monaco.languages.onLanguage(TSX, () => {
    // `typescript` starts its worker the first time a file of it is seen, which a session that only
    // opens .tsx never does; a model that lives for one call is enough to be seen
    monaco.editor.createModel("", "typescript").dispose();
    const worker = async (...uris: monaco.Uri[]) => (await monaco.typescript.getTypeScriptWorker())(...uris);
    const libFiles = new LibFiles(worker);
    const defaults = monaco.typescript.typescriptDefaults;
    const on = defaults.modeConfiguration;
    const l = monaco.languages;
    if (on.completionItems) l.registerCompletionItemProvider(TSX, new SuggestAdapter(worker));
    if (on.signatureHelp) l.registerSignatureHelpProvider(TSX, new SignatureHelpAdapter(worker));
    if (on.hovers) l.registerHoverProvider(TSX, new QuickInfoAdapter(worker));
    if (on.documentHighlights) l.registerDocumentHighlightProvider(TSX, new DocumentHighlightAdapter(worker));
    if (on.definitions) l.registerDefinitionProvider(TSX, new DefinitionAdapter(libFiles, worker));
    if (on.references) l.registerReferenceProvider(TSX, new ReferenceAdapter(libFiles, worker));
    if (on.documentSymbols) l.registerDocumentSymbolProvider(TSX, new OutlineAdapter(worker));
    if (on.rename) l.registerRenameProvider(TSX, new RenameAdapter(libFiles, worker));
    if (on.documentRangeFormattingEdits) l.registerDocumentRangeFormattingEditProvider(TSX, new FormatAdapter(worker));
    if (on.onTypeFormattingEdits) l.registerOnTypeFormattingEditProvider(TSX, new FormatOnTypeAdapter(worker));
    if (on.codeActions) l.registerCodeActionProvider(TSX, new CodeActionAdaptor(worker));
    if (on.inlayHints) l.registerInlayHintsProvider(TSX, new InlayHintsAdapter(worker));
    if (on.diagnostics) new DiagnosticsAdapter(libFiles, defaults, TSX, worker);
  });
}
