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

import { readFileSync } from "node:fs"
import { parse } from "luaut-parser"

// The parser has no types built in. These tests analyze against the Luau and
// Roblox libraries, as a project whose config lists them would.
const testLibs = ["luau", "roblox"].map(name =>
    parse(readFileSync(new URL(`../node_modules/@luaut/${name}/index.d.luaut`, import.meta.url), "utf8")))
const analyzer = new Analyzer({ libs: testLibs })
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
        "```luaut-hover\nanswer: 42\n```")
}
{
    const { document, cursor } = open(
        `declare v: string | nil\nif v ~= nil then\n    print(‸v)\nend\n`,
    )
    const result = hover(analyzer.get(document), cursor)
    check("hover: shows the narrowed type", (result?.contents as { value: string }).value,
        "```luaut-hover\nv: string\n```")
}
{
    const { document, cursor } = open(`const part = Instance.new("Part")\nprint(part.Posi‸tion)\n`)
    const result = hover(analyzer.get(document), cursor)
    check("hover: property of a Roblox class", (result?.contents as { value: string }).value,
        "```luaut-hover\nPosition: Vector3\n```")
}

// Declarations, not just uses. Scope analysis indexes these separately, and
// hovering them used to show nothing at all.
{
    const hoverText = (src: string): string | undefined => {
        const { document, cursor } = open(src)
        return (hover(analyzer.get(document), cursor)?.contents as { value: string } | undefined)?.value
    }
    check("hover: a const declaration", hoverText(`const nu‸ms = [1, 2]\nprint(nums)\n`),
        "```luaut-hover\nconst nums: number[]\n```")
    check("hover: a let declaration", hoverText(`let cou‸nt = 1\nprint(count)\n`),
        "```luaut-hover\nlet count: number\n```")
    check("hover: a parameter",
        hoverText(`const function f(x‸s: number[]): number\n    return #xs\nend\n`),
        "```luaut-hover\n(parameter) xs: number[]\n```")
    check("hover: a function name",
        hoverText(`const function first‸Two(xs: number[]): number\n    return 1\nend\n`),
        "```luaut-hover\nconst firstTwo: (xs: number[]) -> number\n```")
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
            ?.value.replace(/^```luaut-hover\n|\n```$/g, "")
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

    const defaults = tokensOf(`const main = 1\nexport default main\nconst options = { default: 1 }\nprint(options.default)\n`)
    contains("semantic: `default` after `export` is a control keyword", defaults, "default:keyword.control")
    contains("semantic: a property named `default` is still a property", defaults, "default:property")
    check("semantic: reserved words are left to the grammar",
        defaults.some(t => t.startsWith("const:") || t.startsWith("export:")), false)
}

// --- completion where people actually type ------------------------------
// A member access alone on a line is a syntax error, and that is exactly where
// `obj.` gets typed. These used to fall back to listing the globals.
{
    const labelsAt = (src: string): string[] => {
        const { document, cursor } = open(src)
        return completion(analyzer, document, cursor).map(i => i.label)
    }
    check("completion: `obj.` on its own line after a multi-line object",
        labelsAt(`const obj = {\n    a: 1\n}\nobj.‸`), ["a"])
    contains("completion: `game.` alone on a line", labelsAt(`game.‸\n`), "Workspace")
    contains("completion: a chain `game.Workspace.`", labelsAt(`game.Workspace.‸\n`), "Name")
    contains("completion: `:` on a string reaches the string library", labelsAt(`const s = "abc"\ns:‸\n`), "upper")
    check("completion: nothing, rather than globals, when a type has no members",
        labelsAt(`const xs = [1, 2]\nxs.‸\n`), [])
    check("completion: `..` is concatenation, not member access",
        labelsAt(`const alpha = 1\nprint("a" ..‸)\n`).includes("alpha"), true)
}

// --- modules -----------------------------------------------------------
// Real files in a temp folder, since imports resolve against the file system.
{
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { pathToFileURL } = await import("node:url")
    const { importDefinition } = await import("../src/features/imports.js")

    const root = mkdtempSync(join(tmpdir(), "luaut-modules-"))
    mkdirSync(join(root, "shared"))
    writeFileSync(join(root, "shared", "shapes.luaut"), [
        "export type Point = { x: number, y: number }",
        "export const ORIGIN: Point = { x: 0, y: 0 }",
        "export const function distance(a: Point, b: Point): number",
        "    return a.x - b.x",
        "end",
        "export default ORIGIN",
        "",
    ].join("\n"))

    const modules = new Analyzer({ libs: testLibs })
    const file = (name: string, text: string) => {
        const index = text.indexOf("‸")
        const clean = index < 0 ? text : text.slice(0, index) + text.slice(index + 1)
        writeFileSync(join(root, name), clean)
        const document = TextDocument.create(pathToFileURL(join(root, name)).href, "luaut", 1, clean)
        return { document, cursor: document.positionAt(Math.max(index, 0)) }
    }
    const hoverText = (document: TextDocument, cursor: Position): string | undefined =>
        (hover(modules.get(document), cursor)?.contents as { value: string } | undefined)?.value

    {
        const { document, cursor } = file("main.luaut",
            `import origin, { ORIGIN, distance, Point } from "./shared/shapes"\nconst p: Point = { x: 1, y: 2 }\nprint(dist‸ance(p, ORIGIN), origin)\n`)
        check("modules: an imported function has its real type, not any",
            hoverText(document, cursor)?.includes("-> number"), true)
        check("modules: a valid import has no diagnostics", diagnostics(modules.get(document)).map(d => d.message), [])
    }
    {
        const { document } = file("broken.luaut",
            `import { nope } from "./shared/shapes"\nimport x from "./missing"\nprint(nope, x)\n`)
        const messages = diagnostics(modules.get(document)).map(d => d.message)
        contains("modules: a missing module is reported", messages, "Cannot find module './missing'")
        contains("modules: a missing export is reported", messages, "Module './shared/shapes' has no exported member 'nope'")
    }
    {
        const { document } = file("typed.luaut", `import { ORIGIN } from "./shared/shapes"\nconst wrong: string = ORIGIN\n`)
        check("modules: an import is type-checked", diagnostics(modules.get(document)).length, 1)
    }
    {
        const { document, cursor } = file("paths.luaut", `import { ORIGIN } from "./‸"\n`)
        const labels = completion(modules, document, cursor).map(i => i.label)
        contains("modules: path completion lists folders", labels, "shared/")
        contains("modules: path completion lists modules without the extension", labels, "main")
        check("modules: a file is not offered to itself", labels.includes("paths"), false)
    }
    {
        const { document, cursor } = file("nested.luaut", `import { ORIGIN } from "./shared/‸"\n`)
        contains("modules: path completion inside a folder", completion(modules, document, cursor).map(i => i.label), "shapes")
    }
    {
        const { document, cursor } = file("names.luaut", `import { ORIGIN, ‸ } from "./shared/shapes"\n`)
        const labels = completion(modules, document, cursor).map(i => i.label)
        contains("modules: exported values inside the braces", labels, "distance")
        contains("modules: exported types inside the braces", labels, "Point")
        check("modules: names already imported are not offered again", labels.includes("ORIGIN"), false)
    }
    {
        const { document, cursor } = file("jump.luaut", `import { dist‸ance } from "./shared/shapes"\nprint(distance)\n`)
        const location = importDefinition(modules, modules.get(document), cursor)
        check("modules: definition jumps into the other module", location?.uri.endsWith("shapes.luaut"), true)
        check("modules: ...to the exported declaration", location?.range.start, { line: 2, character: 22 })
    }
    {
        const { document, cursor } = file("member.luaut", `import origin from "./shared/shapes"\norigin.‸\n`)
        contains("modules: members of a default import", completion(modules, document, cursor).map(i => i.label), "x")
    }
    {
        // Export lists, a renamed export, and `export *`.
        writeFileSync(join(root, "barrel.luaut"), [
            `export * from "./shared/shapes"`,
            `const five = 5`,
            `type Pair = [number, number]`,
            `export { five, Pair, five as cinq }`,
            "",
        ].join("\n"))
        const { document } = file("fromBarrel.luaut",
            `import { distance, ORIGIN, five, cinq, Pair } from "./barrel"\nconst pair: Pair = [1, 2]\nprint(distance(ORIGIN, ORIGIN), five, pair)\nconst wrong: string = cinq\n`)
        check("modules: export lists and `export *` carry their types",
            diagnostics(modules.get(document)).map(d => d.message), ["Type '5' is not assignable to 'string'"])
        const location = importDefinition(modules, modules.get(document), { line: 0, character: 10 })
        check("modules: definition follows `export *` to the declaring module", location?.uri.endsWith("shapes.luaut"), true)
    }
    {
        const { document } = file("badExports.luaut",
            `export { nothing }\nexport { nope } from "./shared/shapes"\nexport * from "./gone"\n`)
        const messages = diagnostics(modules.get(document)).map(d => d.message)
        contains("modules: exporting a name that does not exist", messages, "Cannot find name 'nothing' to export")
        contains("modules: re-exporting a missing member", messages, "Module './shared/shapes' has no exported member 'nope'")
        contains("modules: re-exporting from a missing module", messages, "Cannot find module './gone'")
    }
    {
        // A module that does not exist yet, and then does.
        const { document } = file("later.luaut", `import { soon } from "./notYet"\nprint(soon)\n`)
        contains("modules: before the module exists",
            diagnostics(modules.get(document)).map(d => d.message), "Cannot find module './notYet'")
        writeFileSync(join(root, "notYet.luaut"), `export const soon = 1\n`)
        check("modules: creating it re-checks the importer", diagnostics(modules.get(document)).map(d => d.message), [])
    }
    {
        const { document, cursor } = file("typeImport.luaut",
            `import { Po‸int } from "./shared/shapes"\nconst p: Point = { x: 1, y: 2 }\n`)
        check("modules: a type-only import hovers as its type",
            hoverText(document, cursor)?.includes("type Point = { x: number, y: number }"), true)
        const typed = file("typePosition.luaut", `import { Point } from "./shared/shapes"\nconst q: Po‸ = { x: 1, y: 2 }\n`)
        contains("modules: an imported type is offered in a type position",
            completion(modules, typed.document, typed.cursor).map(i => i.label), "Point")
    }
    {
        // Editing the imported module invalidates the importer's cached result.
        const { document } = file("watch.luaut", `import { ORIGIN } from "./shared/shapes"\nconst n: { x: number, y: number } = ORIGIN\n`)
        check("modules: before the export changes", diagnostics(modules.get(document)).length, 0)
        writeFileSync(join(root, "shared", "shapes.luaut"), `export const ORIGIN = "moved"\n`)
        check("modules: after it changes, the importer is re-checked", diagnostics(modules.get(document)).length, 1)
    }
}

// --- call arguments --------------------------------------------------
// An argument is checked against its parameter, a generic one against its
// constraint, and a string argument offers what its parameter accepts.
{
    const messagesOf = (src: string): string[] => diagnostics(analyzer.get(open(src).document)).map(d => d.message)

    check("arguments: a string where a number is expected", messagesOf(`wait("")\n`),
        ["Argument of type '\"\"' is not assignable to parameter of type 'number | nil'"])
    check("arguments: a literal outside a literal union",
        messagesOf(`declare function pick(kind: "a" | "b"): nil\npick("c")\n`),
        ["Argument of type '\"c\"' is not assignable to parameter of type '\"a\" | \"b\"'"])
    check("arguments: a generic parameter is checked against its constraint",
        messagesOf(`game.GetService(game, "")\n`).some(m => m.startsWith("Argument of type '\"\"' is not assignable to parameter of type '\"")), true)
    check("arguments: the same through a method call",
        messagesOf(`game:GetService("Nope")\n`).length, 1)
    check("arguments: correct calls stay clean",
        messagesOf(`wait()\nwait(1)\nprint(game:GetService("Players"), game.GetService(game, "Workspace"))\n`), [])

    const labelsAt = (src: string): string[] => {
        const { document, cursor } = open(src)
        return completion(analyzer, document, cursor).map(i => i.label)
    }
    const services = labelsAt(`game.GetService(game, "‸")\n`)
    contains("completion: a string argument offers what its parameter accepts", services, "ReplicatedStorage")
    check("completion: and nothing else — no variables inside quotes", services.includes("print"), false)
    contains("completion: through a method call, mid-word", labelsAt(`game:GetService("Rep‸")\n`), "ReplicatedStorage")
    check("completion: a string with no expected values offers nothing", labelsAt(`print("‸")\n`), [])
}

// --- projects ----------------------------------------------------------
// Real folders: configs, installed type libraries, aliases and a sourcemap.
{
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { dirname, join } = await import("node:path")
    const { fileURLToPath, pathToFileURL } = await import("node:url")

    const root = mkdtempSync(join(tmpdir(), "luaut-project-"))
    const put = (path: string, text: string): void => {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), text)
    }
    // The type libraries, installed the way a project would have them.
    for (const name of ["luau", "roblox"]) {
        const installed = fileURLToPath(new URL(`../node_modules/@luaut/${name}/`, import.meta.url))
        for (const file of ["package.json", "index.d.luaut"]) {
            put(`node_modules/@luaut/${name}/${file}`, readFileSync(join(installed, file), "utf8"))
        }
    }

    put("game/luaut.config.json", JSON.stringify({ types: ["roblox"], paths: { "@shared/*": ["shared/*"] }, sourceMap: "sourcemap.json" }))
    put("game/shared/util.luaut", "export const VALUE = 1\n")
    put("game/sourcemap.json", JSON.stringify({
        name: "Game", className: "DataModel", children: [
            { name: "ReplicatedStorage", className: "ReplicatedStorage", children: [
                { name: "Remotes", className: "Folder" },
                { name: "Main", className: "ModuleScript", filePaths: ["main.luau"] },
            ] },
        ],
    }))
    put("game/lite/luaut.config.json", JSON.stringify({ types: ["luau"], paths: {}, sourceMap: null }))
    put("dup/luaut.config.json", "{}")
    put("dup/luaut.config.jsonc", "{}")
    put("missing/luaut.config.json", JSON.stringify({ types: ["nope"], paths: {}, sourceMap: null }))

    const projects = new Analyzer()
    const openFile = (path: string, text: string): TextDocument => {
        put(path, text)
        return TextDocument.create(pathToFileURL(join(root, path)).href, "luaut", 1, text)
    }

    const main = projects.get(openFile("game/main.luaut", [
        `import { VALUE } from "@shared/util"`,
        `const remotes: Folder = script.Parent.Remotes`,
        `const value: number = VALUE`,
        `const wrong: string = game.ReplicatedStorage.Remotes`,
        "",
    ].join("\n")))
    check("projects: a file takes its folder's config", main.project.config?.path.endsWith(join("game", "luaut.config.json")), true)
    const mainMessages = diagnostics(main).map(d => d.message)
    check("projects: types, a paths alias and the sourcemap all apply — only the deliberate error remains",
        mainMessages.length === 1 && mainMessages[0].endsWith("is not assignable to 'string'"), true)

    const lite = projects.get(openFile("game/lite/x.luaut", "print(game)\n"))
    check("projects: a nested config replaces the outer one",
        [lite.project.config?.path.endsWith(join("lite", "luaut.config.json")), lite.types.aliases.has("Part"), lite.types.aliases.has("Partial")],
        [true, false, true])

    const loose = projects.get(TextDocument.create(
        pathToFileURL(join(dirname(root), `luaut-no-config-${Date.now()}`, "x.luaut")).href, "luaut", 1, "print(1)\n"))
    check("projects: a file no config covers has no types at all", [loose.project.config, loose.types.aliases.size], [undefined, 0])

    check("projects: two configs in one folder are reported on both",
        projects.get(openFile("dup/x.luaut", "")).project.problems.length, 2)
    check("projects: a missing type library is reported",
        projects.get(openFile("missing/x.luaut", "")).project.problems.map(problem => problem.message),
        ["Cannot find type library 'nope'. Install it with: npm i -D @luaut/nope"])

    // Editing a config re-checks the files under it.
    put("game/lite/luaut.config.json", JSON.stringify({ types: ["roblox"], paths: {}, sourceMap: null }))
    check("projects: editing a config re-checks its files",
        projects.get(openFile("game/lite/x.luaut", "print(game)\n")).types.aliases.has("Part"), true)

    const labelsAt = (path: string, text: string): string[] => {
        const index = text.indexOf("‸")
        const document = openFile(path, text.slice(0, index) + text.slice(index + 1))
        return completion(projects, document, document.positionAt(index)).map(i => i.label)
    }
    contains("projects: a paths alias is offered as an import path",
        labelsAt("game/c1.luaut", `import { VALUE } from "@‸"\n`), "@shared/")
    contains("projects: and what is inside it",
        labelsAt("game/c2.luaut", `import { VALUE } from "@shared/‸"\n`), "util")

    rmSync(root, { recursive: true, force: true })
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
