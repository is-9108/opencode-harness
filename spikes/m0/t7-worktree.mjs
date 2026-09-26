// #7 worktree を作業場所にした子セッション
import { createSession, prompt, summary, model, api } from "./lib.mjs"
const wt = process.argv[2]
const parent = await createSession({ title: "m0 wt parent" })
const child = await createSession({ title: "m0 wt child", parentID: parent.id }, { directory: wt })
console.log("child.directory =", child.directory)
const r = await prompt(child.id, {
  agent: "spike-echo",
  model: model("openai/gpt-6-luna"),
  parts: [{ type: "text", text: "Use the bash tool to run exactly: git rev-parse --abbrev-ref HEAD && echo from-agent > from-agent.txt . Then reply with the branch name." }],
}, { directory: wt })
console.log(JSON.stringify(summary(r), null, 1))
