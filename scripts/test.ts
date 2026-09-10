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

// Declarations, not just uses. Scope analysis indexes these separately, and
// hovering them used to show nothing at all.
{
    const hoverText = (src: string): string | undefined => {
        const { document, cursor } = open(src)
        return (hover(analyzer.get(document), cursor)?.contents as { value: string } | undefined)?.value
    }
    check("hover: a const declaration", hoverText(`const nu‸ms = [1, 2]\nprint(nums)\n`),
        "```luaut\nconst nums: number[]\n```")
    check("hover: a let declaration", hoverText(`let cou‸nt = 1\nprint(count)\n`),
        "```luaut\nlet count: number\n```")
    check("hover: a parameter",
        hoverText(`const function f(x‸s: number[]): number\n    return #xs\nend\n`),
        "```luaut\n(parameter) xs: number[]\n```")
    check("hover: a function name",
        hoverText(`const function first‸Two(xs: number[]): number\n    return 1\nend\n`),
        "```luaut\nconst firstTwo: (xs: number[]) -> number\n```")
}
{
    const { document, cursor } = open(`const tot‸al = 1\nprint(total)\n`)
    const analysis = analyzer.get(document)
    check("references: from the declaration itself", references(analysis, cursor, true).length, 2)
    check("rename: from the declaration itself",
        Object.values(rename(analysis, cursor, "sum")?.changes ?? {})[0]?.length, 2)
}

// Keys, definitions and types. Each of these used to show nothing (or, for an
// object key, the whole object).
{
    const hoverText = (src: string): string | undefined => {
        const { document, cursor } = open(src)
        return (hover(analyzer.get(document), cursor)?.contents as { value: string } | undefined)
            ?.value.replace(/^```luaut\n|\n```$/g, "")
    }
    check("hover: an object literal key shows that property",
        hoverText(`const obj = { na‸me: "n", count: 2 }\nprint(obj)\n`), "(property) name: string")
    check("hover: a declared value",
        hoverText(`declare fo‸o: { bar: number }\n`), "declare foo: { bar: number }")
    check("hover: a declared function",
        hoverText(`declare function gre‸et(name: string): nil\n`), "declare function greet(name: string) -> nil")
    check("hover: an overloaded declaration shows its own signature",
        hoverText(`declare function f(x: string): string\ndeclare function ‸f(x: number): number\n`),
        "declare function f(x: number) -> number  (+1 overload)")
    check("hover: a mapped type's key",
        hoverText(`type M<T> = { [‸K in keyof T]: T[K] }\n`)?.startsWith("(type parameter) K in "), true)
    check("hover: an infer name", hoverText(`type R<T> = T extends () -> infer ‸U ? U : never\n`), "(type parameter) infer U")
    check("hover: a use of an infer name", hoverText(`type R<T> = T extends () -> infer U ? ‸U : never\n`), "(type parameter) infer U")
    check("hover: a type query resolves to the value's type",
        hoverText(`const d = { v: 1 }\nconst c: typ‸eof d = { v: 2 }\n`), "{ v: number }")
    check("hover: a type literal property",
        hoverText(`declare foo: { ba‸r: number, baz?: string }\n`), "(property) bar: number")
    check("hover: an optional type literal property",
        hoverText(`declare foo: { bar: number, ba‸z?: string }\n`), "(property) baz?: string")
    check("hover: a property name is not confused with a same-named type",
        hoverText(`type bar = string\ndeclare foo: { bar: ba‸r }\n`), "type bar = string")
    check("hover: a parameter in a function type",
        hoverText(`declare foo: (co‸unt: number) -> string\n`), "(parameter) count: number")
    check("hover: a primitive type", hoverText(`const n: numb‸er = 1\n`), "type number")
    check("hover: an alias by reference",
        hoverText(`type Shape = { r: number }\nconst s: Sha‸pe = { r: 1 }\n`), "type Shape = { r: number }")
    check("hover: an alias by its own name",
        hoverText(`type Sha‸pe = { r: number }\n`), "type Shape = { r: number }")
    check("hover: a library type", hoverText(`const p: Pa‸rt = Instance.new("Part")\n`)?.startsWith("type Part = "), true)
    check("hover: a generic parameter",
        hoverText(`type Box<T extends string> = { value: ‸T }\n`), "(type parameter) T extends string")
    check("hover: a long object type goes one member per line",
        hoverText(`print(ma‸th)\n`)?.startsWith("math: {\n    floor: (x: number) -> number,"), true)
}

// --- semantic tokens ---------------------------------------------------
// Each token decoded back to `word:type.modifier...`, so a test can say what a
// word should be coloured as.
{
    const { semanticTokens, semanticTokensLegend } = await import("../src/features/semanticTokens.js")
    const tokensOf = (src: string): string[] => {
        const { document } = open(src)
        const data = semanticTokens(analyzer.get(document)).data
        const lines = document.getText().split("\n")
        const out: string[] = []
        let line = 0
        let character = 0
        for (let i = 0; i < data.length; i += 5) {
            line += data[i]
            character = data[i] === 0 ? character + data[i + 1] : data[i + 1]
            const word = lines[line].slice(character, character + data[i + 2])
            const type = semanticTokensLegend.tokenTypes[data[i + 3]]
            const modifiers = semanticTokensLegend.tokenModifiers.filter((_, bit) => data[i + 4] & (1 << bit))
            out.push([`${word}:${type}`, ...modifiers].join("."))
        }
        return out
    }

    const conditional = tokensOf(`type Ret<T> = T extends (...unknown) -> infer R ? R : never\n`)
    contains("semantic: `extends` in a conditional is a keyword", conditional, "extends:keyword")
    contains("semantic: `type` declaring an alias is a keyword", conditional, "type:keyword")
    contains("semantic: the alias name", conditional, "Ret:type.declaration")
    contains("semantic: a type parameter's declaration", conditional, "T:typeParameter.declaration")
    contains("semantic: a type parameter's use", conditional, "T:typeParameter")
    contains("semantic: `infer` is a keyword", conditional, "infer:keyword")
    contains("semantic: the inferred name", conditional, "R:typeParameter.declaration")
    contains("semantic: a primitive type", conditional, "unknown:type.defaultLibrary")

    const call = tokensOf(`print(type(1))\n`)
    contains("semantic: `type(x)` in code is a call, not a keyword", call, "type:function.defaultLibrary")

    const declared = tokensOf(`declare function greet(name: string): nil\nconst d = { v: 1 }\nconst c: typeof d = d\n`)
    contains("semantic: a declared function's name", declared, "greet:function.declaration")
    contains("semantic: a declared function's parameter", declared, "name:parameter.declaration")
    contains("semantic: `declare` is a keyword", declared, "declare:keyword")
    contains("semantic: `typeof` in a type is a keyword", declared, "typeof:keyword")
    contains("semantic: the queried value is a variable", declared, "d:variable.readonly")
    contains("semantic: a const declaration", declared, "c:variable.declaration.readonly")

    const literal = tokensOf(`declare foo: { readonly bar: number, run: (x: number) -> nil }\n`)
    contains("semantic: a readonly property in a type", literal, "bar:property.declaration.readonly")
    contains("semantic: a function-typed property is a method", literal, "run:method.declaration")
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
