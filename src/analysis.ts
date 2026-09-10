/**
 * Analysis cache.
 *
 * The three parser passes are cheap (single-digit milliseconds for a normal
 * file) but not free, and every LSP request wants the same result for the same
 * document version — so each document is analyzed once per version and the
 * result is reused by hover, definition, completion and the rest.
 */
import {
    parseWithRecovery, analyzeScopes, analyzeTypes, defaultLibs, getBinding,
    type Program, type ScopeAnalysis, type TypeAnalysis, type ParseError,
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
}

export interface AnalyzerOptions {
    /** Definitions to analyze against. Defaults to core Luau + Roblox. */
    libs?: readonly Program[]
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

export class Analyzer {
    private readonly libs: readonly Program[]
    private readonly builtinGlobals: string[]
    private readonly cache = new Map<string, Analysis>()

    constructor(options: AnalyzerOptions = {}) {
        this.libs = options.libs ?? defaultLibs
        this.builtinGlobals = globalsOf(this.libs)
    }

    /** Analyze `document`, reusing the previous result if its version is
     *  unchanged. */
    get(document: TextDocument): Analysis {
        const cached = this.cache.get(document.uri)
        const source = document.getText()
        // The version alone would do for a real editor, where it only ever
        // increases — comparing the text too costs nothing next to an
        // analysis and makes the cache safe for any caller.
        if (cached && cached.version === document.version && cached.source === source) return cached
        const analysis = this.analyze(document.uri, document.version, source)
        this.cache.set(document.uri, analysis)
        return analysis
    }

    /** Analyze source text that is not a tracked document — used by
     *  completion, which analyzes a speculatively edited copy of the file. */
    analyze(uri: string, version: number, source: string): Analysis {
        const { program, errors } = parseWithRecovery(source)
        const scopes = analyzeScopes(program, { builtinGlobals: this.builtinGlobals })
        const types = analyzeTypes(program, scopes, { libs: this.libs })
        return { uri, version, source, program, parseErrors: errors, scopes, types }
    }

    forget(uri: string): void {
        this.cache.delete(uri)
    }
}
