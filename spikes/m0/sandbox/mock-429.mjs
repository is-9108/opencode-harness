import http from "node:http"
import { appendFileSync } from "node:fs"
http.createServer((req, res) => {
  appendFileSync("mock-hits.log", `${new Date().toISOString()} ${req.method} ${req.url}\n`)
  res.writeHead(429, { "content-type": "application/json", "retry-after": "7200" })
  res.end(JSON.stringify({ type: "error", error: { type: "GoUsageLimitError", message: "Rolling 5-hour usage limit reached" }, metadata: { workspace: "wrk_mock", limitName: "5-hour" } }))
}).listen(4599, () => console.log("mock on 4599"))
