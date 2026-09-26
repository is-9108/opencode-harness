// #9 session.idle をきっかけに、プラグインが同じセッションへ自動でプロンプトを送れるか
import { createSession, prompt, model, api, sleep, textOf } from "./lib.mjs"
const s = await createSession({ title: "[autocontinue] m0" })
await prompt(s.id, { agent: "spike-echo", model: model("openai/gpt-6-luna"), parts: [{ type: "text", text: "Reply with exactly: FIRST" }] })
for (let i = 0; i < 24; i++) {
  await sleep(5000)
  const msgs = await api("GET", `/session/${s.id}/message`)
  const view = msgs.map((m) => `${m.info.role}${m.info.role === "assistant" ? `(${m.info.providerID}/${m.info.modelID}, agent=${m.info.agent ?? m.info.mode})` : ""}: ${textOf(m).replace(/\s+/g, " ").slice(0, 80)}${m.info.error ? " ERR " + JSON.stringify(m.info.error).slice(0, 150) : ""}`)
  const status = (await api("GET", "/session/status"))[s.id]
  if (msgs.length >= 4 && (!status || status.type === "idle")) { console.log(view.join("\n")); process.exit(0) }
  if (i === 23) console.log("TIMEOUT", JSON.stringify(status), "\n" + view.join("\n"))
}
