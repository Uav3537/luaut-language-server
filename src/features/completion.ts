/**
 * Completion.
 *
 * `x.` and `x:` are syntax errors, so the file as typed cannot answer "what
 * are `x`'s members?". The trick every language server of this shape uses:
 * substitute a placeholder identifier at the cursor, analyze *that* text, and
 * read the answer off the AST it produces. The user's document is untouched —
 * only the speculative copy is analyzed, and it is never cached.
 */
import {
    CompletionItemKind, InsertTextFormat,
    type CompletionItem, type Position,
} from "vscode-languageserver"
import type { TextDocument } from "vscode-languageserver-textdocument"
import { formatType, type Expression, type Type } from "luaut-parser"
import type { Analyzer } from "../analysis.js"
import { pathAt, type Spanned } from "../ast-utils.js"
import { membersOf, signaturesOf, signatureLabel } from "./members.js"

const PLACEHOLDER = "__luautCompletion__"
const IDENTIFIER_CHAR = /[A-Za-z0-9_]/

export function completion(
    analyzer: Analyzer,
    document: TextDocument,
    position: Position,
): CompletionItem[] {
    const source = document.getText()
    const offset = document.offsetAt(position)

    // The word being typed, if any — replaced wholesale so a half-written
    // name cannot break the speculative parse.
    let start = offset
    while (start > 0 && IDENTIFIER_CHAR.test(source[start - 1])) start--
    let end = offset
    while (end < source.length && IDENTIFIER_CHAR.test(source[end])) end++

    // A method name has to be called to parse (`part:foo` alone is not a
    // statement), so the placeholder brings its own argument list unless the
    // source already has one.
    const afterColon = source[start - 1] === ":"
    const alreadyCalled = /^\s*\(/.test(source.slice(end))
    const stand_in = afterColon && !alreadyCalled ? `${PLACEHOLDER}()` : PLACEHOLDER
    const patched = source.slice(0, start) + stand_in + source.slice(end)
    const analysis = analyzer.analyze(document.uri, -1, patched)

    // Where the placeholder sits, in the patched document's coordinates —
    // the same line, since the patch never spans one.
    const at: Position = { line: position.line, character: position.character - (offset - start) }
    const path = pathAt(analysis.program, at, true)
    const placeholder = [...path].reverse().find(
        n => n.type === "Identifier" && (n as unknown as { name: string }).name === PLACEHOLDER,
    )
    const parent = placeholder ? path[path.indexOf(placeholder) - 1] : path[path.length - 1]

    // Member access: `x.foo` / `x:foo`.
    if (parent && (parent.type === "MemberExpression" || parent.type === "MethodCallExpression")) {
        const object = (parent as unknown as { object: Expression }).object
        const type = analysis.types.typeOf.get(object)
        const wantMethods = parent.type === "MethodCallExpression"
        return membersOf(type, analysis.types.aliases)
            .filter(member => (wantMethods ? member.isMethod : true))
            .map(member => memberItem(member.name, member.property.type, member.property.readonly))
    }

    // A type position wants type names, not values.
    if (inTypePosition(path)) {
        const named: CompletionItem[] = [...analysis.types.aliases.keys()].map(name => ({
            label: name,
            kind: CompletionItemKind.Interface,
            detail: "type",
        }))
        const primitives: CompletionItem[] = PRIMITIVES.map(name => ({
            label: name,
            kind: CompletionItemKind.Keyword,
            detail: "type",
        }))
        return [...named, ...primitives]
    }

    return valueItems(analysis, at)
}

/** Names in scope at `at`. Scope analysis records where each binding is
 *  declared but not the extent of its scope, so this approximates: everything
 *  declared earlier in the file, plus the globals, which are visible
 *  everywhere. Over-offering is the right failure — a name the editor lists
 *  and the file rejects is a diagnostic away from being obvious. */
function valueItems(analysis: ReturnType<Analyzer["analyze"]>, at: Position): CompletionItem[] {
    const items: CompletionItem[] = []
    const seen = new Set<string>()
    for (const binding of analysis.scopes.bindings.values()) {
        if (binding.name === PLACEHOLDER || seen.has(binding.name)) continue
        const declaration = binding.declarationNode as unknown as Spanned | undefined
        if (declaration && declaration.line.start - 1 > at.line) continue
        seen.add(binding.name)
        const type = analysis.types.bindingType.get(binding.id)
        items.push({
            label: binding.name,
            kind: kindOf(type, binding.kind),
            detail: type ? formatType(type) : undefined,
            // Locals before globals, and globals before library names.
            sortText: `${binding.isBuiltin ? 2 : binding.kind === "global" ? 1 : 0}${binding.name}`,
        })
    }
    for (const keyword of KEYWORDS) {
        items.push({ label: keyword, kind: CompletionItemKind.Keyword, sortText: `3${keyword}` })
    }
    return items
}

function memberItem(name: string, type: Type, readonly?: boolean): CompletionItem {
    const signatures = signaturesOf(type)
    if (signatures.length) {
        return {
            label: name,
            kind: CompletionItemKind.Method,
            detail: signatureLabel(signatures[0]).label,
            insertText: `${name}($0)`,
            insertTextFormat: InsertTextFormat.Snippet,
        }
    }
    return {
        label: name,
        kind: CompletionItemKind.Field,
        detail: `${readonly ? "readonly " : ""}${formatType(type)}`,
    }
}

function kindOf(type: Type | undefined, bindingKind: string): CompletionItemKind {
    if (type && signaturesOf(type).length) return CompletionItemKind.Function
    if (bindingKind === "param" || bindingKind === "self") return CompletionItemKind.Variable
    return CompletionItemKind.Variable
}

/** Is the cursor inside a type annotation? Every type node's name ends in
 *  `TypeNode`, plus the couple that do not. */
function inTypePosition(path: readonly Spanned[]): boolean {
    return path.some(n =>
        !!n.type && (n.type.endsWith("TypeNode") || n.type === "TypeReference"
            || n.type === "TypeAliasStatement" || n.type === "ExportTypeAliasStatement"),
    )
}

const PRIMITIVES = [
    "any", "unknown", "never", "nil", "boolean", "number", "string", "thread", "buffer",
]

const KEYWORDS = [
    "const", "let", "function", "return", "if", "then", "elseif", "else", "end",
    "for", "in", "while", "do", "repeat", "until", "break", "continue",
    "type", "declare", "export", "import", "and", "or", "not", "true", "false", "nil",
]
