/** Syntax errors, scope errors and type errors, as one list. */
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver"
import type { Analysis } from "../analysis.js"
import { toRange, toPosition } from "../ast-utils.js"

export function diagnostics(analysis: Analysis): Diagnostic[] {
    const out: Diagnostic[] = []

    for (const error of analysis.parseErrors) {
        // A parse error points at a token, not a span; highlight to the end of
        // the word under it so the squiggle is visible.
        const start = toPosition(error.line, error.column)
        out.push({
            range: { start, end: { line: start.line, character: start.character + 1 } },
            severity: DiagnosticSeverity.Error,
            source: "luaut",
            code: "syntax",
            // The parser appends `(line:column)`; the range already says that.
            message: error.message.replace(/\s*\(\d+:\d+\)$/, ""),
        })
    }

    for (const d of analysis.scopes.diagnostics) {
        out.push({
            range: toRange(d.node),
            severity: DiagnosticSeverity.Error,
            source: "luaut",
            code: d.kind,
            message: d.message,
        })
    }

    for (const d of analysis.types.diagnostics) {
        out.push({
            range: toRange(d.node),
            severity: DiagnosticSeverity.Error,
            source: "luaut",
            code: "type",
            message: d.message,
        })
    }

    return out
}
