/** Hover: the type of the thing under the cursor, as luaut would write it. */
import type { Hover, Position } from "vscode-languageserver"
import { formatType, type Identifier, type Expression, type Type } from "luaut-parser"
import { bindingOfNode, type Analysis } from "../analysis.js"
import { pathAt, toRange, type Spanned } from "../ast-utils.js"

export function hover(analysis: Analysis, position: Position): Hover | null {
    const path = pathAt(analysis.program, position, true)
    for (let i = path.length - 1; i >= 0; i--) {
        const node = path[i]
        const found = describe(analysis, node, path[i - 1])
        if (found) return { contents: { kind: "markdown", value: code(found) }, range: toRange(node) }
    }
    return null
}

function describe(analysis: Analysis, node: Spanned, parent?: Spanned): string | undefined {
    const { types } = analysis

    // A type alias reads as its definition rather than as a value.
    if (node.type === "TypeAliasStatement" || node.type === "ExportTypeAliasStatement") {
        const name = (node as unknown as { name: string }).name
        const alias = types.aliases.get(name)
        if (alias) return `type ${name} = ${formatType(alias)}`
    }

    if (node.type === "Identifier") {
        const identifier = node as unknown as Identifier
        // A reference: prefer the narrowed type — that is what the code sees
        // at this point, and the difference is the whole reason for narrowing.
        const narrowed = types.narrowedTypeOf.get(identifier)
        if (narrowed) return `${identifier.name}: ${formatType(narrowed)}`
        const binding = bindingOfNode(analysis, identifier)
        if (binding) {
            const type = types.bindingType.get(binding.id)
            if (type) return `${keyword(binding)} ${binding.name}: ${formatType(type)}`
        }
        // A property name: `x.foo` has no binding, but the member expression
        // it belongs to has a type.
        if (parent && (parent.type === "MemberExpression" || parent.type === "MethodCallExpression")) {
            const type = types.typeOf.get(parent as unknown as Expression)
            if (type) return `${identifier.name}: ${formatType(type)}`
        }
    }

    // Declarations: `const x`, a parameter, `const function f`.
    if (node.type === "IdentifierPattern" || node.type === "FunctionParameter"
        || node.type === "TypedIdentifier") {
        const binding = bindingOfNode(analysis, node)
        if (binding) {
            const type = types.bindingType.get(binding.id)
            if (type) return `${keyword(binding)} ${binding.name}: ${formatType(type)}`
        }
    }

    const type: Type | undefined = types.typeOf.get(node as unknown as Expression)
    return type ? formatType(type) : undefined
}

function keyword(binding: { kind: string; isConst?: boolean }): string {
    if (binding.kind === "param" || binding.kind === "self") return "(parameter)"
    if (binding.kind === "global") return "(global)"
    if (binding.kind.startsWith("for-")) return "(loop variable)"
    return binding.isConst ? "const" : "let"
}

function code(text: string): string {
    return "```luaut\n" + text + "\n```"
}
