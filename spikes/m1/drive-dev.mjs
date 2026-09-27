// TUI の代わりに HTTP API で /dev を実行し、司令塔の question に自動で答える（#10 の受け入れ基準の確認用）
// 1 回目の承認の問い → 修正指示（内容も答える）、2 回目 → 承認
const BASE = process.env.OC_BASE ?? "http://127.0.0.1:4097"
const ISSUE = process.env.ISSUE ?? "3"
const MODEL = process.env.MODEL ?? "openai/gpt-6-luna"
const FEEDBACK = "境界値のテストケースを 1 件追加してください（観点のレビュー結果が空のとき）。"

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// SESSION を指定すると、既存のセッションに接続し直す（コマンドは送らない）
const session = process.env.SESSION ? { id: process.env.SESSION } : await api("POST", "/session", { title: `drive /dev ${ISSUE}` })
log("session", session.id)
// コマンドの HTTP 応答は 5 分で切れるので待たない。完了はセッションの状態（idle）と質問の有無で判定する
if (!process.env.SESSION) api("POST", `/session/${session.id}/command`, { command: "dev", arguments: ISSUE, agent: "harness", model: MODEL }).catch(() => {})
const isIdle = async () => { const st = (await api("GET", "/session/status"))[session.id]; return !st || st.type === "idle" }

let approvals = Number(process.env.APPROVALS ?? 0)
const started = Date.now()
const perms = async () => { const all = await api("GET", "/permission"); for (const p of all.filter((x) => x.sessionID === session.id)) { log("PERMISSION:", p.permission, p.patterns.join(",")); await api("POST", `/session/${session.id}/permissions/${p.id}`, { response: "once" }) } }
while (Date.now() - started < Number(process.env.TIMEOUT_MIN ?? 40) * 60_000) {
  await perms()
  const data = (await api("GET", "/question")).filter((q) => q.sessionID === session.id)
  for (const req of data ?? []) {
    const answers = req.questions.map((q) => {
      const labels = (q.options ?? []).map((o) => o.label)
      log("QUESTION:", q.question.replace(/\s+/g, " ").slice(0, 200), "| options:", labels.join(" / "))
      // 依存先の確認（#31）: DEP_ANSWER（待つ / 積む / 無視）を含む選択肢を選ぶ
      const dep = labels.find((l) => process.env.DEP_ANSWER && l.includes(process.env.DEP_ANSWER))
      if (dep) return [dep]
      // 選択肢に「承認」があれば判断の問い、なければ修正内容を聞く問いとみなす（問いの文面に「具体的」などが入ることがあるため）
      const asksDetail = labels.length === 0 || !labels.some((l) => /承認/.test(l))
      if (asksDetail) return [FEEDBACK]
      const want = approvals === 0 ? /修正/ : /承認/
      const pick = labels.find((l) => want.test(l)) ?? labels[0]
      if (/承認|修正/.test(pick)) approvals++
      return pick === labels.find((l) => /修正/.test(l)) && labels.length > 0 ? [pick] : [pick]
    })
    log("ANSWER:", JSON.stringify(answers))
    await api("POST", `/question/${req.id}/reply`, { answers })
  }
  if ((data ?? []).length === 0 && Date.now() - started > 10_000 && (await isIdle())) { log("session idle"); break }
  await sleep(3000)
}

// 司令塔のツール呼び出しと最後の発言を表示する
const msgs = await api("GET", `/session/${session.id}/message`)
for (const m of msgs) for (const p of m.parts) {
  if (p.type === "tool" && p.tool.startsWith("harness_")) log("TOOL", p.tool, JSON.stringify(p.state?.input ?? {}), "->", String(p.state?.output ?? p.state?.error ?? "").replace(/\s+/g, " ").slice(0, 260))
}
const last = msgs.filter((m) => m.info.role === "assistant").at(-1)
log("FINAL:", (last?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join(" ").replace(/\s+/g, " ").slice(0, 600))
const kids = await api("GET", `/session/${session.id}/children`)
log("children:", kids.map((k) => `${k.id} ${k.title}`).join(" | "))
