/**
 * Analysis cache, and the module graph behind `import`.
 *
 * The three parser passes are cheap (single-digit milliseconds for a normal
 * file) but not free, and every LSP request wants the same result for the same
 * document version — so each document is analyzed once per version and the
 * result is reused by hover, definition, completion and the rest.
 *
 * An import is resolved to a file, that file is analyzed the same way, and its
 * exports become the importing file's types. Open documents are read in
 * preference to disk, so an import sees unsaved edits. A cached result is only
 * reused while every module it imported — and everything those import — still
 * has the text it was analyzed against.
 */
import { readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
    parseWithRecovery, analyzeScopes, analyzeTypes, moduleExports, defaultLibs, getBinding,
    type Program, type ScopeAnalysis, type TypeAnalysis, type ParseError, type ModuleExports,
    type DeclareStatement, type Statement, type Binding, type Identifier,
} from "luaut-parser"
import type { TextDocument } from "vscode-languageserver-textdocument"

export interface Analysis {
    readonly uri: string
    readonly version: number
    readonly source: string
    readonly program: Program
    readonly parseErrors: readonly ParseError[]
    readonly scopes: ScopeAnalysis
    readonly types: TypeAnalysis
    /** Every file this analysis read for an import, with the text it read —
     *  or `undefined` for a file it looked for and did not find. How a cached
     *  result tells that an import changed, appeared or vanished under it. */
    readonly dependencies: ReadonlyMap<string, string | undefined>
}

export interface AnalyzerOptions {
    /** Definitions to analyze against. Defaults to core Luau + Roblox. */
    libs?: readonly Program[]
    /** The open document for a file path, if there is one. */
    openDocument?: (path: string) => TextDocument | undefined
}

/** Names every file may use undeclared: whatever the definitions declare.
 *  Derived rather than hard-coded, so adding a `declare` to a `.d.luaut` is
 *  all it takes for the name to stop looking undefined. */
function globalsOf(libs: readonly Program[]): string[] {
    const names = new Set<string>()
    for (const lib of libs) collect(lib.body.statements, names)
    return [...names]
}

function collect(statements: readonly Statement[], into: Set<string>): void {
    for (const statement of statements) {
        if (statement.type === "DeclareStatement") into.add((statement as DeclareStatement).name)
    }
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

export class Analyzer {
    private readonly libs: readonly Program[]
    private readonly builtinGlobals: string[]
    private readonly openDocument?: (path: string) => TextDocument | undefined
    private readonly cache = new Map<string, Analysis>()
    /** Imported modules, by path key. */
    private readonly modules = new Map<string, Module>()

    constructor(options: AnalyzerOptions = {}) {
        this.libs = options.libs ?? defaultLibs
        this.builtinGlobals = globalsOf(this.libs)
        this.openDocument = options.openDocument
    }

    /** Analyze `document`, reusing the previous result while neither it nor
     *  anything it imports has changed. */
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

    /** The file an import in `fromUri` names. Relative paths only (`./x`,
     *  `../x`); the extension may be left off, and a folder means its
     *  `index.luaut`. */
    resolveModulePath(fromUri: string, specifier: string): string | undefined {
        return this.moduleCandidates(fromUri, specifier).find(candidate => this.sourceOf(candidate) !== undefined)
    }

    /** Every file an import could mean, in the order they are tried. */
    private moduleCandidates(fromUri: string, specifier: string): string[] {
        const from = pathOfUri(fromUri)
        if (!from || !(specifier.startsWith("./") || specifier.startsWith("../"))) return []
        const base = resolve(dirname(from), specifier)
        return specifier.endsWith(".luaut")
            ? [base]
            : [`${base}.luaut`, `${base}.d.luaut`, join(base, "index.luaut")]
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

    private sourceOf(path: string): string | undefined {
        const open = this.openDocument?.(path)
        if (open) return open.getText()
        try {
            return statSync(path).isFile() ? readFileSync(path, "utf8") : undefined
        } catch {
            return undefined
        }
    }

    /** `importing` holds every module on the current import chain, so an
     *  import back into one of them is recognized as a cycle. */
    private analyzeModule(uri: string, version: number, source: string, importing: Set<string>): Analysis {
        const { program, errors } = parseWithRecovery(source)
        const scopes = analyzeScopes(program, { builtinGlobals: this.builtinGlobals })
        const dependencies = new Map<string, string | undefined>()
        const types = analyzeTypes(program, scopes, {
            libs: this.libs,
            resolveModule: specifier => {
                const target = this.resolveModulePath(uri, specifier)
                if (!target) {
                    // Remember where it was looked for. Otherwise creating the
                    // file later would leave this module's "Cannot find module"
                    // — and its unresolved types — cached until its own text
                    // changed.
                    for (const candidate of this.moduleCandidates(uri, specifier)) dependencies.set(candidate, undefined)
                    return undefined
                }
                const exports = this.exportsOf(target, importing)
                dependencies.set(target, this.sourceOf(target))
                return exports
            },
        })
        return { uri, version, source, program, parseErrors: errors, scopes, types, dependencies }
    }

    private exportsOf(path: string, importing: Set<string>): ModuleExports | undefined {
        const key = pathKey(path)
        if (importing.has(key)) return CYCLE
        const source = this.sourceOf(path)
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

    /** Does every module `analysis` imported — and everything those import —
     *  still have the text it was analyzed against? */
    private isFresh(analysis: Analysis, seen = new Set<Analysis>()): boolean {
        if (seen.has(analysis)) return true
        seen.add(analysis)
        for (const [path, source] of analysis.dependencies) {
            if (this.sourceOf(path) !== source) return false
            const module = this.modules.get(pathKey(path))
            if (module && !this.isFresh(module.analysis, seen)) return false
        }
        return true
    }
}
