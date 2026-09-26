// Codex(ChatGPT) 経由で実際に使えるモデルを確認する
import { createSession, prompt, model } from "./lib.mjs"
const models = process.argv.slice(2)
await Promise.all(models.map(async (m) => {
  const s = await createSession({ title: `probe ${m}` })
  const r = await prompt(s.id, { agent: "spike-echo", model: model(m), parts: [{ type: "text", text: "Reply with OK only." }] })
  const e = r.info?.error
  console.log(m.padEnd(28), e ? `NG ${e.data?.statusCode ?? ""} ${(e.data?.message ?? e.name).slice(0, 120)}` : `OK in=${r.info.tokens.input} out=${r.info.tokens.output} cache.read=${r.info.tokens.cache.read} cost=${r.info.cost}`)
}))
