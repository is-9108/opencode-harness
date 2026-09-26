// #1 agent 指定 / #5 途中でモデル切り替え / #8 tokens・cost / 子セッション
import { api, createSession, prompt, summary, model } from "./lib.mjs"

const parent = await createSession({ title: "m0 parent" })
const child = await createSession({ title: "m0 child", parentID: parent.id })
console.log("parent", parent.id, "child", child.id, "child.parentID", child.parentID)

const r1 = await prompt(child.id, {
  agent: "spike-echo",
  model: model(process.env.M1 ?? "openai/gpt-6-luna"),
  parts: [{ type: "text", text: "Remember the code word PINEAPPLE-42. Reply with a short ok." }],
})
console.log("#1/#8 first (M1, agent=spike-echo):", JSON.stringify(summary(r1), null, 1))

const r2 = await prompt(child.id, {
  agent: "spike-echo",
  model: model(process.env.M2 ?? "openai/gpt-5.5"),
  parts: [{ type: "text", text: "What was the code word I asked you to remember? Answer with just the word." }],
})
console.log("#5 second (switched to M2):", JSON.stringify(summary(r2), null, 1))

const kids = await api("GET", `/session/${parent.id}/children`)
console.log("children of parent:", kids.map((k) => k.id))
