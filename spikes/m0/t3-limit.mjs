// #3 上限エラーの現れ方: 偽プロバイダ(mock/limited)が 429 + GoUsageLimitError + retry-after:7200 を返す
// 期待: エラーで終わらず session.status が retry になり、next が 2 時間後になる → ハーネスは abort して切り替える
import { createSession, model, api, sleep } from "./lib.mjs"
const s = await createSession({ title: "m0 limit" })
await api("POST", `/session/${s.id}/prompt_async`, { agent: "spike-echo", model: model("mock/limited"), parts: [{ type: "text", text: "hi" }] })
for (let i = 0; i < 10; i++) {
  await sleep(2000)
  const st = (await api("GET", "/session/status"))[s.id]
  if (st?.type === "retry") {
    console.log(JSON.stringify({ ...st, waitMinutes: Math.round((st.next - Date.now()) / 60000) }, null, 1))
    console.log("abort ->", await api("POST", `/session/${s.id}/abort`))
    await sleep(1500)
    console.log("status after abort:", JSON.stringify((await api("GET", "/session/status"))[s.id] ?? { type: "idle" }))
    process.exit(0)
  }
}
console.log("no retry status observed")
