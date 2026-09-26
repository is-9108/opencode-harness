// #2 プラグインのツールを長時間実行する / 中断がツールに伝わるか
// usage: node t2-long-tool.mjs <seconds> [abortAfterSec]
import { createSession, prompt, summary, model, api, sleep } from "./lib.mjs"
const seconds = Number(process.argv[2]); const abortAfter = process.argv[3] ? Number(process.argv[3]) : undefined
const s = await createSession({ title: `m0 long tool ${seconds}s` })
const started = Date.now()
if (abortAfter) setTimeout(async () => { console.log("abort ->", await api("POST", `/session/${s.id}/abort`)) }, abortAfter * 1000)
try {
  const r = await prompt(s.id, { agent: "spike-tool", model: model("openai/gpt-6-luna"),
    parts: [{ type: "text", text: `Sleep for ${seconds} seconds using spike_sleep.` }] })
  const tool = (r.parts ?? []).find((p) => p.type === "tool")
  console.log(JSON.stringify({ elapsedSec: Math.round((Date.now() - started) / 1000), toolState: tool?.state?.status, toolOutput: tool?.state?.output ?? tool?.state?.error, ...summary(r) }))
} catch (e) { console.log("ERROR after", Math.round((Date.now() - started) / 1000), "s:", e.message) }
