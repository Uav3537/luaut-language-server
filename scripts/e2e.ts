/**
 * End-to-end check: launch the built binary the way an editor does (stdio,
 * LSP framing) and hold a short conversation with it. This is the only test
 * that exercises `server.ts` — everything else calls the features directly.
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const child = spawn(process.execPath, [resolve(here, "../dist/cli.js"), "--stdio"], {
    stdio: ["pipe", "pipe", "inherit"],
})

let buffer = Buffer.alloc(0)
const waiting = new Map<number, (message: any) => void>()
const notifications: any[] = []

child.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
        const header = buffer.indexOf("\r\n\r\n")
        if (header < 0) return
        const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, header).toString())?.[1])
        const start = header + 4
        if (buffer.length < start + length) return
        const message = JSON.parse(buffer.subarray(start, start + length).toString())
        buffer = buffer.subarray(start + length)
        if (message.id !== undefined && waiting.has(message.id)) {
            waiting.get(message.id)!(message)
            waiting.delete(message.id)
        } else {
            notifications.push(message)
        }
    }
})

function send(message: unknown): void {
    const body = JSON.stringify(message)
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

let nextId = 1
function request(method: string, params: unknown): Promise<any> {
    const id = nextId++
    return new Promise(resolve => {
        waiting.set(id, resolve)
        send({ jsonrpc: "2.0", id, method, params })
    })
}

function notify(method: string, params: unknown): void {
    send({ jsonrpc: "2.0", method, params })
}

const uri = "file:///e2e.luaut"
const failures: string[] = []
function check(name: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a !== b) failures.push(`${name}\n    expected ${b}\n    actual   ${a}`)
}

const initialized = await request("initialize", {
    processId: process.pid, rootUri: null, capabilities: {},
})
check("initialize: advertises hover", initialized.result.capabilities.hoverProvider, true)
notify("initialized", {})

notify("textDocument/didOpen", {
    textDocument: {
        uri, languageId: "luaut", version: 1,
        text: 'const part = Instance.new("Part")\nconst bad: number = "x"\nprint(part.Name)\n',
    },
})

const hovered = await request("textDocument/hover", {
    textDocument: { uri },
    position: { line: 2, character: 8 },
})
// A *reference* hovers as its narrowed type; the `const` keyword shows on the
// declaration itself.
check("hover over the binding", hovered.result?.contents?.value, "```luaut\npart: Part\n```")

const completed = await request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 2, character: 11 },
    context: { triggerKind: 2, triggerCharacter: "." },
})
const labels = (completed.result as { label: string }[]).map(i => i.label)
check("completion over the wire", labels.includes("Name"), true)

// Diagnostics arrive as a notification, on open and after every change.
await new Promise(r => setTimeout(r, 200))
const published = notifications.filter(n => n.method === "textDocument/publishDiagnostics")
check("diagnostics were published", published.length > 0, true)
check("the type error is among them",
    published.at(-1)?.params.diagnostics.some((d: { message: string }) => /number/.test(d.message)),
    true)

await request("shutdown", null)
notify("exit", null)

for (const failure of failures) console.log(`FAIL ${failure}`)
console.log(failures.length ? `\n${failures.length} failed` : "\ne2e ok")
process.exit(failures.length ? 1 : 0)
