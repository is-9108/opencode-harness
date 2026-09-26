// #2 の続き: サーバ側のツール実行が最後まで終わるかを監視する
import { api, sleep } from "./lib.mjs"
const id = process.argv[2]
for (;;) {
  const msgs = await api("GET", `/session/${id}/message`)
  const tool = msgs.flatMap((m) => m.parts).find((p) => p.type === "tool")
  const st = (await api("GET", "/session/status"))[id]
  if (tool && tool.state.status !== "running" && (!st || st.type === "idle")) {
    const text = msgs.filter((m) => m.info.role === "assistant").flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => p.text).join(" ")
    console.log(JSON.stringify({ toolStatus: tool.state.status, output: tool.state.output ?? tool.state.error, durationSec: Math.round((tool.state.time.end - tool.state.time.start) / 1000), finalText: text.slice(0, 80), errors: msgs.map((m) => m.info.error).filter(Boolean) }))
    break
  }
  await sleep(30000)
}
