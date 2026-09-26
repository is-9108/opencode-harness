// #10 並列レビューを想定: 別セッションで「共通の長い入力(diff 相当) → 観点の指示」の順に送り、キャッシュが効くか
import { createSession, prompt, model } from "./lib.mjs"
const diff = Array.from({ length: 600 }, (_, i) => `+ const value${i} = compute(${i}, "shared diff line for cache test");`).join("\n")
const run = async (perspective, i) => {
  const s = await createSession({ title: `m0 cache ${perspective}` })
  const r = await prompt(s.id, { agent: "spike-echo", model: model("openai/gpt-6-luna"),
    parts: [{ type: "text", text: `# Shared review input\n${diff}\n\n# Perspective\nYou review from the "${perspective}" perspective. Reply with one short sentence.` }] })
  const t = r.info.tokens
  console.log(`${i} ${perspective.padEnd(15)} input=${t.input} cache.read=${t.cache.read} total=${t.total}`)
}
console.log("sequential:")
await run("spec", 1)
await run("test-integrity", 2)
console.log("parallel (after warm-up):")
await Promise.all([run("advisory", 3), run("judge", 4)])
