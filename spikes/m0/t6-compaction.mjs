// #6 limit.input の上書きで、その値を閾値として自動圧縮が起きるか
// 対象サーバ: OC_BASE=http://127.0.0.1:4098 （limit.input=30000, reserved=5000 → 25k で圧縮される想定）
import { createSession, prompt, model, api } from "./lib.mjs"
const s = await createSession({ title: "m0 compaction" })
const filler = (n) => Array.from({ length: 700 }, (_, i) => `R${n}-L${i}: harness spike filler sentence about worktrees, reviewers and loops number ${i * 7 + n}.`).join("\n")
for (let n = 1; n <= 4; n++) {
  const r = await prompt(s.id, { agent: "spike-echo", model: model("openai/gpt-6-luna"),
    parts: [{ type: "text", text: `Round ${n}. Read this text and reply with only its first line.\n${filler(n)}` }] })
  const msgs = await api("GET", `/session/${s.id}/message`)
  const kinds = msgs.map((m) => m.info.role[0] + (m.info.summary ? "[SUMMARY]" : "") + (m.parts.some((p) => p.type === "compaction") ? "[COMPACTION]" : ""))
  console.log(`round ${n}: total=${r.info.tokens.total} input=${r.info.tokens.input} cache.read=${r.info.tokens.cache.read} err=${r.info.error?.name ?? "-"} msgs=${kinds.join(",")}`)
}
