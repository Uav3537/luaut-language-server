/**
 * `import`, across files: completing the module path and the imported names,
 * and jumping from an import into the module it names.
 *
 * Completion works on the line's text rather than the AST — an import that is
 * being typed does not parse yet, and those are exactly the moments completion
 * is asked for.
 */
import { readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
    CompletionItemKind,
    type Command, type CompletionItem, type Location, type Position, type Range,
} from "vscode-languageserver"
import type { TextDocument } from "vscode-languageserver-textdocument"
import { formatType, type BindingTarget, type ImportStatement } from "luaut-parser"
import { pathOfUri, samePath, uriOfPath, type Analysis, type Analyzer } from "../analysis.js"
import { pathAt, toRange, type Spanned } from "../ast-utils.js"
import { signaturesOf } from "./members.js"

/** Keep the suggestion list open after picking a folder, to go one level in. */
const SUGGEST_AGAIN: Command = { title: "Suggest", command: "editor.action.triggerSuggest" }

/** Completion inside an import, or `undefined` when the cursor is not in one. */
export function importCompletion(
    analyzer: Analyzer,
    document: TextDocument,
    position: Position,
): CompletionItem[] | undefined {
    const text = document.getText()
    const cursor = document.offsetAt(position)
    const lineStart = document.offsetAt({ line: position.line, character: 0 })
    const lineEnd = document.offsetAt({ line: position.line + 1, character: 0 })
    const before = text.slice(lineStart, cursor)
    const after = text.slice(cursor, lineEnd)
    if (!/^\s*import\b/.test(before)) return undefined

    // In the module path: `from "./sha|"`.
    const path = /\bfrom\s*(["'])([^"']*)$/.exec(before)
    if (path) return pathItems(document.uri, position, path[2])

    // In the braces: `import { a, | } from "./x"`.
    if (/^\s*import\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*,\s*)?\{[^}]*$/.test(before)) {
        const module = /\}\s*from\s*(["'])([^"']+)\1/.exec(after)
        return module ? nameItems(analyzer, document.uri, module[2], before) : []
    }
    return undefined
}

function pathItems(fromUri: string, position: Position, typed: string): CompletionItem[] {
    const from = pathOfUri(fromUri)
    if (!from) return []

    // Only relative paths resolve; until one is started, offer the ways in.
    if (!typed.startsWith("./") && !typed.startsWith("../")) {
        const range = rangeBack(position, typed.length)
        return ["./", "../"].map(label => ({
            label,
            kind: CompletionItemKind.Folder,
            textEdit: { range, newText: label },
            command: SUGGEST_AGAIN,
        }))
    }

    const slash = typed.lastIndexOf("/")
    const directory = resolve(dirname(from), typed.slice(0, slash + 1))
    const range = rangeBack(position, typed.length - slash - 1)
    let entries
    try {
        entries = readdirSync(directory, { withFileTypes: true })
    } catch {
        return []
    }

    const items: CompletionItem[] = []
    for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue
        if (entry.isDirectory()) {
            items.push({
                label: `${entry.name}/`,
                kind: CompletionItemKind.Folder,
                textEdit: { range, newText: `${entry.name}/` },
                command: SUGGEST_AGAIN,
            })
        } else if (entry.name.endsWith(".luaut")) {
            // A file does not import itself.
            if (samePath(resolve(directory, entry.name), from)) continue
            const name = entry.name.replace(/(\.d)?\.luaut$/, "")
            items.push({
                label: name,
                kind: CompletionItemKind.File,
                detail: entry.name,
                textEdit: { range, newText: name },
            })
        }
    }
    return items
}

function nameItems(analyzer: Analyzer, fromUri: string, specifier: string, before: string): CompletionItem[] {
    const target = analyzer.resolveModulePath(fromUri, specifier)
    const exports = target ? analyzer.exportsAt(target) : undefined
    if (!exports) return []

    // Names already in the braces are not offered again.
    const braces = before.slice(before.indexOf("{") + 1)
    const listed = new Set(braces.split(",").map(part => part.trim().split(/\s+/)[0]).filter(Boolean))

    const items: CompletionItem[] = []
    for (const [name, type] of exports.values) {
        if (listed.has(name)) continue
        items.push({
            label: name,
            kind: signaturesOf(type).length ? CompletionItemKind.Function : CompletionItemKind.Variable,
            detail: formatType(type),
        })
    }
    for (const [name, exported] of exports.types) {
        if (listed.has(name) || exports.values.has(name)) continue
        items.push({
            label: name,
            kind: CompletionItemKind.Interface,
            detail: `type ${name} = ${formatType(exported.type)}`,
        })
    }
    return items
}

function rangeBack(position: Position, length: number): Range {
    return { start: { line: position.line, character: position.character - length }, end: position }
}

/** Go-to-definition inside an import: the module string opens the module, an
 *  imported name jumps to its export. `undefined` when the cursor is not in an
 *  import at all, so the caller can fall back to ordinary definition. */
export function importDefinition(
    analyzer: Analyzer,
    analysis: Analysis,
    position: Position,
): Location | null | undefined {
    const path = pathAt(analysis.program, position, true)
    const statement = path.find(n => n.type === "ImportStatement") as unknown as ImportStatement | undefined
    if (!statement) return undefined

    const target = analyzer.resolveModulePath(analysis.uri, statement.source.value)
    if (!target) return null
    const at = (node?: Spanned): Location => ({
        uri: uriOfPath(target),
        range: node ? toRange(node) : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    })

    const node = path[path.length - 1] as unknown
    let name: string | undefined
    if (node === statement.defaultImport) name = "default"
    for (const specifier of statement.specifiers) {
        if (node === specifier.imported || node === specifier.local) name = specifier.imported.name
    }
    if (!name) return at()

    const module = analyzer.moduleAt(target)
    return at(module && exportDeclaration(module, name))
}

/** Where a module declares the export `name` (`"default"` for its default). */
export function exportDeclaration(module: Analysis, name: string): Spanned | undefined {
    for (const statement of module.program.body.statements) {
        switch (statement.type) {
            case "ExportDefaultStatement":
                if (name === "default") return statement as unknown as Spanned
                break
            case "ExportTypeAliasStatement":
                if (statement.alias.name.name === name) return statement.alias.name as unknown as Spanned
                break
            case "ExportStatement": {
                const declaration = statement.declaration
                if (declaration.type === "FunctionDeclaration") {
                    if (declaration.name.name === name) return declaration.name as unknown as Spanned
                } else {
                    for (const target of declaration.names) {
                        const found = patternNamed(target, name)
                        if (found) return found
                    }
                }
                break
            }
        }
    }
    return undefined
}

function patternNamed(target: BindingTarget, name: string): Spanned | undefined {
    switch (target.type) {
        case "IdentifierPattern":
            return target.name === name ? (target as unknown as Spanned) : undefined
        case "ObjectPattern":
            for (const property of target.properties) {
                const found = patternNamed(property.value, name)
                if (found) return found
            }
            return target.rest && patternNamed(target.rest, name)
        case "ArrayPattern":
            for (const element of target.elements) {
                const found = element && patternNamed(element.value, name)
                if (found) return found
            }
            return target.rest && patternNamed(target.rest, name)
    }
}
