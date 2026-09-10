/**
 * The language server: LSP wiring only.
 *
 * Every handler is the same three steps — get the cached analysis for the
 * document, ask one feature module a question, hand back the answer. The
 * thinking lives in `features/`; nothing here knows about luaut.
 */
import {
    createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
    type Connection, type InitializeParams, type InitializeResult,
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"
import { Analyzer, pathOfUri, samePath, type AnalyzerOptions } from "./analysis.js"
import { importDefinition } from "./features/imports.js"
import { diagnostics } from "./features/diagnostics.js"
import { hover } from "./features/hover.js"
import { definition, references, highlights, prepareRename, rename } from "./features/navigation.js"
import { completion } from "./features/completion.js"
import { signatureHelp } from "./features/signatureHelp.js"
import { documentSymbols } from "./features/symbols.js"
import { semanticTokens, semanticTokensLegend } from "./features/semanticTokens.js"

export interface ServerOptions extends AnalyzerOptions {}

/** Attach the luaut language server to a connection. Exported separately from
 *  `startServer` so an editor extension can run it in-process over its own
 *  transport, and so the tests can drive it without spawning anything. */
export function createServer(connection: Connection, options: ServerOptions = {}): void {
    const documents = new TextDocuments(TextDocument)
    // Imports read open documents before disk, so they see unsaved edits.
    const analyzer = new Analyzer({
        ...options,
        openDocument: path => documents.all().find(document => {
            const documentPath = pathOfUri(document.uri)
            return documentPath !== undefined && samePath(documentPath, path)
        }),
    })

    connection.onInitialize((_params: InitializeParams): InitializeResult => ({
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true,
            documentSymbolProvider: true,
            renameProvider: { prepareProvider: true },
            completionProvider: {
                // `.` and `:` open a member list; the rest of the time
                // completion is asked for as you type a word.
                // plus the characters that start or extend an import path.
                triggerCharacters: [".", ":", "\"", "'", "/"],
                resolveProvider: false,
            },
            signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
            // Colours from the parser, not from patterns: whether a word is a
            // keyword, a type or a name depends on where it stands.
            semanticTokensProvider: { legend: semanticTokensLegend, full: true },
        },
        serverInfo: { name: "luaut-language-server" },
    }))

    // --- semantic highlighting ---------------------------------------------
    connection.languages.semanticTokens.on(p => {
        const document = documents.get(p.textDocument.uri)
        return document ? semanticTokens(analyzer.get(document)) : { data: [] }
    })

    // --- diagnostics -------------------------------------------------------
    const publish = (document: TextDocument): void => {
        void connection.sendDiagnostics({
            uri: document.uri,
            version: document.version,
            diagnostics: diagnostics(analyzer.get(document)),
        })
    }

    documents.onDidOpen(e => publish(e.document))
    // Any change can affect every open file that imports the changed one, so
    // all of them are re-checked; unchanged ones come straight from the cache.
    const publishAll = (): void => {
        for (const document of documents.all()) publish(document)
    }
    documents.onDidChangeContent(publishAll)
    // A module edited, created or deleted outside the editor.
    connection.onDidChangeWatchedFiles(publishAll)
    documents.onDidClose(e => {
        analyzer.forget(e.document.uri)
        void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] })
    })

    // --- language features -------------------------------------------------
    const withDocument = <T>(uri: string, f: (document: TextDocument) => T, fallback: T): T => {
        const document = documents.get(uri)
        return document ? f(document) : fallback
    }

    connection.onHover(p => withDocument(
        p.textDocument.uri, d => hover(analyzer.get(d), p.position), null,
    ))

    connection.onDefinition(p => withDocument(
        p.textDocument.uri,
        d => {
            const analysis = analyzer.get(d)
            // Inside an import, the definition is in the other module.
            const across = importDefinition(analyzer, analysis, p.position)
            return across !== undefined ? across : definition(analysis, p.position)
        },
        null,
    ))

    connection.onReferences(p => withDocument(
        p.textDocument.uri,
        d => references(analyzer.get(d), p.position, p.context.includeDeclaration),
        [],
    ))

    connection.onDocumentHighlight(p => withDocument(
        p.textDocument.uri, d => highlights(analyzer.get(d), p.position), [],
    ))

    connection.onDocumentSymbol(p => withDocument(
        p.textDocument.uri, d => documentSymbols(analyzer.get(d)), [],
    ))

    connection.onPrepareRename(p => withDocument(
        p.textDocument.uri,
        d => {
            const prepared = prepareRename(analyzer.get(d), p.position)
            return prepared ? { range: prepared.range, placeholder: prepared.placeholder } : null
        },
        null,
    ))

    connection.onRenameRequest(p => withDocument(
        p.textDocument.uri, d => rename(analyzer.get(d), p.position, p.newName), null,
    ))

    connection.onCompletion(p => withDocument(
        p.textDocument.uri, d => completion(analyzer, d, p.position), [],
    ))

    connection.onSignatureHelp(p => withDocument(
        p.textDocument.uri, d => signatureHelp(analyzer, d, p.position), null,
    ))

    documents.listen(connection)
    connection.listen()
}

/** Run the server over stdio — the transport editors launch it with. */
export function startServer(options: ServerOptions = {}): void {
    createServer(createConnection(ProposedFeatures.all), options)
}
