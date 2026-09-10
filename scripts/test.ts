/**
 * Feature tests.
 *
 * Each case is a source fragment with a `‸` marking the cursor: the harness
 * strips it, works out the position, and asks one feature. No server is
 * spawned — the features are plain functions, which is the point of keeping
 * the LSP wiring in `server.ts` and nothing else.
 */
import { TextDocument } from "vscode-languageserver-textdocument"
import { Analyzer } from "../src/analysis.js"
import { diagnostics } from "../src/features/diagnostics.js"
import { hover } from "../src/features/hover.js"
import { definition, references, rename } from "../src/features/navigation.js"
import { completion } from "../src/features/completion.js"
import { signatureHelp } from "../src/features/signatureHelp.js"
import { documentSymbols } from "../src/features/symbols.js"
import type { Position } from "vscode-languageserver"

const analyzer = new Analyzer()
let passed = 0
const failures: string[] = []

let documentCount = 0

function open(source: string): { document: TextDocument; cursor: Position } {
    // Not `|`: that is the union operator, and it turns up in the fixtures.
    const index = source.indexOf("‸")
    const text = index < 0 ? source : source.slice(0, index) + source.slice(index + 1)
    const document = TextDocument.create(`file:///test${documentCount++}.luaut`, "luaut", 1, text)
    return { document, cursor: index < 0 ? { line: 0, character: 0 } : document.positionAt(index) }
}

function check(name: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a === b) { passed++; return }
    failures.push(`${name}\n    expected ${b}\n    actual   ${a}`)
}

function contains(name: string, haystack: readonly string[], needle: string): void {
    if (haystack.includes(needle)) { passed++; return }
    failures.push(`${name}\n    ${needle} missing from [${haystack.slice(0, 12).join(", ")}...]`)
}

// --- hover -------------------------------------------------------------
{
    const { document, cursor } = open(`const answer = 42\nprint(ans‸wer)\n`)
    const result = hover(analyzer.get(document), cursor)
    check("hover: const keeps its literal type", (result?.contents as { value: string }).value,
        "```luaut\nanswer: 42\n```")
}
{
    const { document, cursor } = open(
        `declare v: string | nil\nif v ~= nil then\n    print(‸v)\nend\n`,
    )
    const result = hover(analyzer.get(document), cursor)
    check("hover: shows the narrowed type", (result?.contents as { value: string }).value,
        "```luaut\nv: string\n```")
}
{
    const { document, cursor } = open(`const part = Instance.new("Part")\nprint(part.Posi‸tion)\n`)
    const result = hover(analyzer.get(document), cursor)
    check("hover: property of a Roblox class", (result?.contents as { value: string }).value,
        "```luaut\nPosition: Vector3\n```")
}

// --- diagnostics -------------------------------------------------------
{
    const { document } = open(`const n: number = "text"\n`)
    const found = diagnostics(analyzer.get(document))
    check("diagnostics: one assignability error", found.length, 1)
    // The analyzer reports on the whole declaration, not the initializer.
    check("diagnostics: on the declaration", found[0]?.range,
        { start: { line: 0, character: 0 }, end: { line: 0, character: 24 } })
}
{
    const { document } = open(`const x = \nprint(`)
    const found = diagnostics(analyzer.get(document))
    check("diagnostics: recovers from syntax errors", found.length > 0, true)
}
{
    const { document } = open(`const x = 1\nx = 2\n`)
    const found = diagnostics(analyzer.get(document))
    check("diagnostics: assigning to a const", found.some(d => d.code === "const-assign"), true)
}

// --- navigation --------------------------------------------------------
{
    const source = `const total = 1\nprint(tot‸al)\nprint(total)\n`
    const { document, cursor } = open(source)
    const analysis = analyzer.get(document)
    check("definition: jumps to the declaration", definition(analysis, cursor)?.range,
        { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } })
    check("references: declaration plus both uses",
        references(analysis, cursor, true).length, 3)
    check("references: uses only", references(analysis, cursor, false).length, 2)
    const edit = rename(analysis, cursor, "sum")
    check("rename: edits every site", Object.values(edit?.changes ?? {})[0]?.length, 3)
    check("rename: rejects an invalid name", rename(analysis, cursor, "1bad"), null)
}

// --- completion --------------------------------------------------------
{
    const { document, cursor } = open(`const part = Instance.new("Part")\nprint(part.‸)\n`)
    const labels = completion(analyzer, document, cursor).map(i => i.label)
    contains("completion: members after `.`", labels, "Position")
    contains("completion: inherited members too", labels, "Name")
}
{
    const { document, cursor } = open(`const part = Instance.new("Part")\npart:‸\n`)
    const items = completion(analyzer, document, cursor)
    const labels = items.map(i => i.label)
    contains("completion: methods after `:`", labels, "IsA")
    check("completion: `:` offers only methods",
        labels.includes("Position"), false)
}
{
    const { document, cursor } = open(`const part = Instance.new("Part")\nprint(part.Pos‸)\n`)
    const labels = completion(analyzer, document, cursor).map(i => i.label)
    contains("completion: works mid-word", labels, "Position")
}
{
    const { document, cursor } = open(`const localName = 1\nprint(loc‸)\n`)
    const labels = completion(analyzer, document, cursor).map(i => i.label)
    contains("completion: locals in scope", labels, "localName")
    contains("completion: globals from the definitions", labels, "game")
}
{
    const { document, cursor } = open(`type Alias = number\nconst v: Al‸ = 1\n`)
    const labels = completion(analyzer, document, cursor).map(i => i.label)
    contains("completion: aliases in type position", labels, "Alias")
    contains("completion: primitives in type position", labels, "string")
    check("completion: no values in type position", labels.includes("game"), false)
}

// --- signature help ----------------------------------------------------
{
    const { document, cursor } = open(
        `const function add(a: number, b: string): number\n    return a\nend\nadd(1, ‸)\n`,
    )
    const help = signatureHelp(analyzer, document, cursor)
    check("signature help: label", help?.signatures[0]?.label, "(a: number, b: string) -> number")
    check("signature help: active parameter", help?.activeParameter, 1)
}
{
    const { document, cursor } = open(`const part = Instance.new("Part")\npart:IsA(‸)\n`)
    const help = signatureHelp(analyzer, document, cursor)
    check("signature help: `:` skips self",
        help ? help.activeParameter === 1 : null, true)
}

// --- symbols -----------------------------------------------------------
{
    const { document } = open(
        `type Point = { x: number }\nconst origin = 1\nconst function go(): nil\n    return nil\nend\n`,
    )
    const names = documentSymbols(analyzer.get(document)).map(s => s.name)
    check("symbols: outline", names, ["Point", "origin", "go"])
}

// --- caching -----------------------------------------------------------
{
    const document = TextDocument.create("file:///cache.luaut", "luaut", 1, "const a = 1\n")
    check("analysis is cached per version", analyzer.get(document) === analyzer.get(document), true)
}

// -----------------------------------------------------------------------
for (const failure of failures) console.log(`FAIL ${failure}`)
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
