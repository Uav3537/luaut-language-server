/**
 * Analysis cache, projects, and the module graph behind `import`.
 *
 * The three parser passes are cheap (single-digit milliseconds for a normal
 * file) but not free, and every LSP request wants the same result for the same
 * document version — so each document is analyzed once per version and the
 * result is reused by hover, definition, completion and the rest.
 *
 * Nothing is built in. A file belongs to the project of the nearest
 * `luaut.config.json`: the type libraries it names, its `paths` aliases, and
 * its sourcemap's instance tree. A file no config covers gets no types at all.
 *
 * An import is resolved to a file, that file is analyzed the same way, and its
 * exports become the importing file's types. Open documents are read in
 * preference to disk, so an import sees unsaved edits. A cached result is only
 * reused while every file it read — the modules it imports, its config, type
 * libraries and sourcemap — still has the text it was analyzed against.
 */
import { readFileSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
    parse, parseWithRecovery, analyzeScopes, analyzeTypes, moduleExports, getBinding,
    findConfig, resolveTypeLibraries, moduleCandidates, sourceMapTypes,
    type Program, type ScopeAnalysis, type TypeAnalysis, type ParseError, type ModuleExports,
    type Binding, type Identifier, type Type, type LuautConfig, type ConfigProblem, type ProjectHost,
    type SourceMapTypes,
} from "luaut-parser"
import type { TextDocument } from "vscode-languageserver-textdocument"
import { membersOf } from "./features/members.js"

export interface Analysis {
    readonly uri: string
    readonly version: number
    readonly source: string
    readonly program: Program
    readonly parseErrors: readonly ParseError[]
    readonly scopes: ScopeAnalysis
    readonly types: TypeAnalysis
    /** Every file this analysis read — imported modules, its config, type
     *  libraries, sourcemap — with the text it read, or `undefined` for a file
     *  it looked for and did not find. How a cached result tells that something
     *  changed, appeared or vanished under it. */
    readonly dependencies: ReadonlyMap<string, string | undefined>
    /** The project the file belongs to. */
    readonly project: Project
}

export interface Project {
    /** The config that applies to the file, or `undefined` when none does. */
    readonly config?: LuautConfig
    /** The types came from `AnalyzerOptions.libs`, not from a config. */
    readonly fixed: boolean
    /** What is wrong with the config, a type library it names, or its sourcemap. */
    readonly problems: readonly ConfigProblem[]
}

export interface AnalyzerOptions {
    /** Analyze every file against these definitions instead of the ones its
     *  `luaut.config.json` names — for tests and for embedding the server. */
    libs?: readonly Program[]
    /** The open document for a file path, if there is one. */
    openDocument?: (path: string) => TextDocument | undefined
}

/** Names a file may use undeclared: whatever the definitions declare. */
function globalsOf(libs: readonly Program[]): string[] {
    const names = new Set<string>()
    for (const lib of libs) {
        for (const statement of lib.body.statements) {
            if (statement.type === "DeclareStatement") names.add(statement.name)
        }
    }
    return [...names]
}

/** The binding a node names, whether it *uses* the binding or *declares* it.
 *
 *  Scope analysis indexes the two differently: every use is in `bindingOf`,
 *  but a declaration only appears as its binding's `declarationNode`. Asking
 *  `bindingOf` alone is why hovering `const x` — as opposed to a later `x` —
 *  used to show nothing. */
export function bindingOfNode(analysis: Analysis, node: object): Binding | undefined {
    const used = getBinding(analysis.scopes, node as Identifier)
    if (used) return used
    return declarationIndex(analysis).get(node)
}

const declarationIndexes = new WeakMap<Analysis, Map<object, Binding>>()

function declarationIndex(analysis: Analysis): Map<object, Binding> {
    let index = declarationIndexes.get(analysis)
    if (!index) {
        index = new Map()
        for (const binding of analysis.scopes.bindings.values()) {
            if (binding.declarationNode) index.set(binding.declarationNode, binding)
        }
        declarationIndexes.set(analysis, index)
    }
    return index
}

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

/** A file URI's path, or `undefined` for anything that is not a file. */
export function pathOfUri(uri: string): string | undefined {
    if (!uri.startsWith("file:")) return undefined
    try {
        return fileURLToPath(uri)
    } catch {
        return undefined
    }
}

export function uriOfPath(path: string): string {
    return pathToFileURL(path).href
}

/** Paths compare case-insensitively on Windows, where editors and the file
 *  system disagree about drive-letter case. */
export function samePath(a: string, b: string): boolean {
    return pathKey(a) === pathKey(b)
}

function pathKey(path: string): string {
    const normalized = resolve(path)
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

/** What an import of a module still being analyzed up the chain sees. */
const CYCLE: ModuleExports = { values: new Map(), types: new Map(), partial: true }

// --------------------------------------------------------------------------
// Analyzer
// --------------------------------------------------------------------------

interface Module {
    analysis: Analysis
    exports: ModuleExports
}

/** Everything a folder's files are analyzed with. */
interface Context {
    readonly project: Project
    /** The type libraries, then the sourcemap's tree. */
    readonly libs: readonly Program[]
    readonly globals: readonly string[]
    readonly sourceMap?: SourceMapTypes
    /** Every file read to build this, with what it held. */
    readonly reads: ReadonlyMap<string, string | undefined>
}

const NO_PROJECT: Context = { project: { fixed: false, problems: [] }, libs: [], globals: [], reads: new Map() }

export class Analyzer {
    private readonly fixed?: Context
    private readonly openDocument?: (path: string) => TextDocument | undefined
    private readonly cache = new Map<string, Analysis>()
    /** Imported modules, by path key. */
    private readonly modules = new Map<string, Module>()
    /** Project contexts, by folder. */
    private readonly contexts = new Map<string, Context>()
    /** Parsed type libraries, by path — reparsed only when the text changes. */
    private readonly libraries = new Map<string, { source: string; program?: Program; problem?: ConfigProblem }>()
    /** Sourcemaps turned into types, by path, with what they were built from. */
    private readonly sourceMaps = new Map<string, { text: string; libraries: string; result: ReturnType<typeof sourceMapTypes> }>()

    constructor(options: AnalyzerOptions = {}) {
        this.openDocument = options.openDocument
        if (options.libs) {
            this.fixed = {
                project: { fixed: true, problems: [] },
                libs: options.libs,
                globals: globalsOf(options.libs),
                reads: new Map(),
            }
        }
    }

    /** Analyze `document`, reusing the previous result while neither it nor
     *  anything it read has changed. */
    get(document: TextDocument): Analysis {
        const cached = this.cache.get(document.uri)
        const source = document.getText()
        if (cached && cached.version === document.version && cached.source === source && this.isFresh(cached)) {
            return cached
        }
        const analysis = this.analyze(document.uri, document.version, source)
        this.cache.set(document.uri, analysis)
        return analysis
    }

    /** Analyze source text that is not a tracked document — used by
     *  completion, which analyzes a speculatively edited copy of the file. */
    analyze(uri: string, version: number, source: string): Analysis {
        const path = pathOfUri(uri)
        return this.analyzeModule(uri, version, source, new Set(path ? [pathKey(path)] : []))
    }

    forget(uri: string): void {
        this.cache.delete(uri)
    }

    /** The project a file belongs to. */
    projectOf(uri: string): Project {
        return this.contextFor(pathOfUri(uri)).project
    }

    /** The file an import in `fromUri` names: a relative path, or a `paths`
     *  alias from the file's config. */
    resolveModulePath(fromUri: string, specifier: string): string | undefined {
        const from = pathOfUri(fromUri)
        if (!from) return undefined
        return this.candidatesFor(from, specifier).find(candidate => this.readFile(candidate) !== undefined)
    }

    /** What the module at `path` exports, analyzing it if need be. */
    exportsAt(path: string): ModuleExports | undefined {
        return this.exportsOf(path, new Set())
    }

    /** The analysis of the module at `path`, analyzing it if need be. */
    moduleAt(path: string): Analysis | undefined {
        this.exportsOf(path, new Set())
        return this.modules.get(pathKey(path))?.analysis
    }

    /** A file's text: the open document if there is one, else the disk. */
    readFile(path: string): string | undefined {
        const open = this.openDocument?.(path)
        if (open) return open.getText()
        try {
            return statSync(path).isFile() ? readFileSync(path, "utf8") : undefined
        } catch {
            return undefined
        }
    }

    private candidatesFor(from: string, specifier: string): string[] {
        return moduleCandidates(from, specifier, this.contextFor(from).project.config)
    }

    // ---------------------------------------------------------------- projects

    private contextFor(path: string | undefined): Context {
        if (this.fixed) return this.fixed
        if (!path) return NO_PROJECT
        const key = pathKey(dirname(path))
        const cached = this.contexts.get(key)
        if (cached && this.unchanged(cached.reads)) return cached
        const context = this.buildContext(path)
        this.contexts.set(key, context)
        return context
    }

    private buildContext(path: string): Context {
        const reads = new Map<string, string | undefined>()
        const host: ProjectHost = {
            readFile: file => {
                const text = this.readFile(file)
                reads.set(file, text)
                return text
            },
        }

        const lookup = findConfig(path, host)
        const problems: ConfigProblem[] = [...lookup.problems]
        const config = lookup.config
        if (!config) return { project: { fixed: false, problems }, libs: [], globals: [], reads }

        const libraries = resolveTypeLibraries(config, host)
        problems.push(...libraries.problems)
        const libs: Program[] = []
        for (const file of libraries.files) {
            const program = this.library(file, host, problems)
            if (program) libs.push(program)
        }

        let sourceMap: SourceMapTypes | undefined
        if (config.sourceMap) {
            const text = host.readFile(config.sourceMap)
            if (text === undefined) {
                problems.push({
                    file: config.path,
                    message: `Cannot find the sourceMap file ${config.sourceMap}`,
                    ...optionPosition(config, "sourceMap"),
                })
            } else {
                const result = this.sourceMap(config.sourceMap, text, libs, libraries.files)
                if (result.problem) problems.push({ file: config.sourceMap, message: result.problem, line: 1, column: 1 })
                sourceMap = result.types
                if (sourceMap) libs.push(sourceMap.program)
            }
        }

        return { project: { config, fixed: false, problems }, libs, globals: globalsOf(libs), sourceMap, reads }
    }

    /** A type library's definitions, parsed once per text. */
    private library(file: string, host: ProjectHost, problems: ConfigProblem[]): Program | undefined {
        const source = host.readFile(file)
        if (source === undefined) return undefined
        const key = pathKey(file)
        let entry = this.libraries.get(key)
        if (!entry || entry.source !== source) {
            try {
                entry = { source, program: parse(source) }
            } catch (error) {
                const { message, line, column } = error as { message: string; line?: number; column?: number }
                entry = {
                    source,
                    problem: { file, message: `Syntax error in type library: ${message.replace(/\s*\(\d+:\d+\)$/, "")}`, line, column },
                }
            }
            this.libraries.set(key, entry)
        }
        if (entry.problem) problems.push(entry.problem)
        return entry.program
    }

    /** A sourcemap's types, rebuilt only when it or the libraries change. */
    private sourceMap(path: string, text: string, libs: readonly Program[], files: readonly string[]): ReturnType<typeof sourceMapTypes> {
        const key = pathKey(path)
        const libraries = files.join("\n")
        const cached = this.sourceMaps.get(key)
        if (cached && cached.text === text && cached.libraries === libraries) return cached.result

        const aliases = aliasesOf(libs)
        const members = new Map<string, ReadonlySet<string>>()
        const result = sourceMapTypes(text, path, {
            classes: new Set(aliases.keys()),
            membersOf: className => {
                let names = members.get(className)
                if (!names) {
                    names = new Set(membersOf(aliases.get(className), aliases).map(member => member.name))
                    members.set(className, names)
                }
                return names
            },
        })
        this.sourceMaps.set(key, { text, libraries, result })
        return result
    }

    private unchanged(reads: ReadonlyMap<string, string | undefined>): boolean {
        for (const [file, text] of reads) if (this.readFile(file) !== text) return false
        return true
    }

    // ----------------------------------------------------------------- modules

    /** `importing` holds every module on the current import chain, so an
     *  import back into one of them is recognized as a cycle. */
    private analyzeModule(uri: string, version: number, source: string, importing: Set<string>): Analysis {
        const path = pathOfUri(uri)
        const context = this.contextFor(path)
        // A file the sourcemap maps has its own `script`.
        const script = path ? context.sourceMap?.scriptFor(path) : undefined
        const libs = script ? [...context.libs, script] : context.libs
        const globals = script ? [...context.globals, "script"] : context.globals

        const { program, errors } = parseWithRecovery(source)
        const scopes = analyzeScopes(program, { builtinGlobals: [...globals] })
        const dependencies = new Map(context.reads)
        const types = analyzeTypes(program, scopes, {
            libs,
            resolveModule: specifier => {
                if (!path) return undefined
                const candidates = this.candidatesFor(path, specifier)
                const target = candidates.find(candidate => this.readFile(candidate) !== undefined)
                if (!target) {
                    // Remember where it was looked for. Otherwise creating the
                    // file later would leave this module's "Cannot find module"
                    // — and its unresolved types — cached until its own text
                    // changed.
                    for (const candidate of candidates) dependencies.set(candidate, undefined)
                    return undefined
                }
                const exports = this.exportsOf(target, importing)
                dependencies.set(target, this.readFile(target))
                return exports
            },
        })
        return { uri, version, source, program, parseErrors: errors, scopes, types, dependencies, project: context.project }
    }

    private exportsOf(path: string, importing: Set<string>): ModuleExports | undefined {
        const key = pathKey(path)
        if (importing.has(key)) return CYCLE
        const source = this.readFile(path)
        if (source === undefined) return undefined
        const cached = this.modules.get(key)
        if (cached && cached.analysis.source === source && this.isFresh(cached.analysis)) return cached.exports
        importing.add(key)
        try {
            const analysis = this.analyzeModule(uriOfPath(path), -1, source, importing)
            // Re-exports (`export ... from`) resolve relative to this module.
            const exports = moduleExports(analysis.program, analysis.scopes, analysis.types, specifier => {
                const next = this.resolveModulePath(analysis.uri, specifier)
                return next ? this.exportsOf(next, importing) : undefined
            })
            this.modules.set(key, { analysis, exports })
            return exports
        } finally {
            importing.delete(key)
        }
    }

    /** Does every file `analysis` read — and everything the modules it
     *  imported read — still have the text it was analyzed against? */
    private isFresh(analysis: Analysis, seen = new Set<Analysis>()): boolean {
        if (seen.has(analysis)) return true
        seen.add(analysis)
        for (const [path, source] of analysis.dependencies) {
            if (this.readFile(path) !== source) return false
            const module = this.modules.get(pathKey(path))
            if (module && !this.isFresh(module.analysis, seen)) return false
        }
        return true
    }
}

/** The type aliases a set of libraries defines, resolved. */
function aliasesOf(libs: readonly Program[]): ReadonlyMap<string, Type> {
    const empty = parse("")
    return analyzeTypes(empty, analyzeScopes(empty, {}), { libs, diagnostics: false }).aliases
}

/** Where an option is written in a config, to point a problem at it. */
export function optionPosition(config: LuautConfig, key: string): { line?: number; column?: number } {
    const offset = config.source.indexOf(JSON.stringify(key))
    if (offset < 0) return { line: 1, column: 1 }
    const before = config.source.slice(0, offset)
    return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n") }
}
