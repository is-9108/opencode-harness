// #7 worktree + セッション作成時の permission ルールで external_directory を許可する
// PERM 環境変数に PermissionRule の配列(JSON)を渡す
import { createSession, prompt, summary, model } from "./lib.mjs"
const wt = process.argv[2]
const permission = JSON.parse(process.env.PERM ?? "[]")
const parent = await createSession({ title: "m0 wt parent 2" })
const child = await createSession({ title: "m0 wt child 2", parentID: parent.id, permission }, { directory: wt })
console.log("child.permission =", JSON.stringify(child.permission))
const r = await prompt(child.id, {
  agent: "spike-echo", model: model("openai/gpt-6-luna"),
  parts: [{ type: "text", text: "Use the bash tool to run exactly: git rev-parse --abbrev-ref HEAD && echo from-agent > from-agent.txt . Then reply with the branch name." }],
}, { directory: wt })
console.log(JSON.stringify(summary(r)))
