// M0 spike helpers: thin client for the opencode server HTTP API
export const BASE = process.env.OC_BASE ?? "http://127.0.0.1:4097"

export async function api(method, path, body, query = {}) {
  const qs = new URLSearchParams(query).toString()
  const res = await fetch(`${BASE}${path}${qs ? "?" + qs : ""}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`)
  return json
}

export const model = (s) => { const [providerID, ...rest] = s.split("/"); return { providerID, modelID: rest.join("/") } }
export const textOf = (r) => (r.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n")
export const summary = (r) => ({
  agent: r.info?.agent ?? r.info?.mode,
  model: `${r.info?.providerID}/${r.info?.modelID}`,
  tokens: r.info?.tokens,
  cost: r.info?.cost,
  error: r.info?.error,
  text: textOf(r).slice(0, 300),
})
export const createSession = (body = {}, query = {}) => api("POST", "/session", body, query)
export const prompt = (id, body, query = {}) => api("POST", `/session/${id}/message`, body, query)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
