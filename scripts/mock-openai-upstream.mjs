// Local OpenAI-compatible upstream used by Flintcode's end-to-end test.
// It logs only request metadata, never prompts or headers beyond a redacted auth state.
import http from "node:http"
import fs from "node:fs"

const port = Number(process.argv[2] ?? 48123)
const logFile = process.env.MOCK_LOG ?? "/storage/emulated/0/Tools/flintcode/mock-upstream.log"
const expectedAuth = `Bearer ${process.env.MOCK_EXPECTED_KEY ?? "test-key"}`
fs.writeFileSync(logFile, "")

function record(entry) {
  fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n")
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (!req.url?.startsWith("/v1/")) {
    res.writeHead(404).end()
    return
  }
  if (req.headers.authorization !== expectedAuth) {
    record({ method: req.method, url: req.url, auth: "invalid", status: 401 })
    res.writeHead(401, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "invalid mock upstream key" } }))
    return
  }
  if (req.method === "GET" && req.url.endsWith("/models")) {
    record({ method: req.method, url: req.url, auth: "ok" })
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "mock-1", object: "model", owned_by: "flintcode-test" },
          { id: "mock-2", object: "model", owned_by: "flintcode-test" },
        ],
      }),
    )
    return
  }
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {}
    const model = typeof body.model === "string" ? body.model : "unknown"
    record({
      method: req.method,
      url: req.url,
      auth: "ok",
      model,
      stream: body.stream === true,
      messages: Array.isArray(body.messages) ? body.messages.length : 0,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
    })
    const created = Math.floor(Date.now() / 1000)
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      res.write(chunk({ role: "assistant", content: "" }))
      res.write(chunk({ content: "MOCK_OK" }))
      res.write(chunk({}, "stop"))
      res.end("data: [DONE]\n\n")
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "MOCK_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }),
    )
    return
  }
  record({ method: req.method, url: req.url, status: 404 })
  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: { message: "not found" } }))
})

server.listen(port, "127.0.0.1", () => {
  console.log(`mock OpenAI upstream listening on http://127.0.0.1:${port}/v1`)
})
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)))
