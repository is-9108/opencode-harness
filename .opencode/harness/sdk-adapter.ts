// プラグインが受け取る SDK クライアント（v1）を、ハーネスの SessionApi に合わせる薄いアダプタ
import type { createOpencodeClient } from "@opencode-ai/sdk"
import type { AssistantResult, PermissionRule, SessionApi } from "./session.ts"

type Client = ReturnType<typeof createOpencodeClient>

export function createSessionApi(client: Client): SessionApi {
  return {
    async create({ parentID, title, directory, permission }) {
      // v1 の型にはないが、サーバはセッションごとの permission を受け付ける（M0-7、docs/spikes.md）
      const body = { parentID, title, permission } as { parentID?: string; title?: string; permission?: PermissionRule[] }
      const res = await client.session.create({ body, query: { directory } })
      return { id: unwrap(res, "セッションを作れませんでした").id }
    },

    async promptAsync({ sessionID, directory, agent, model, text }) {
      const res = await client.session.promptAsync({
        path: { id: sessionID },
        query: { directory },
        body: { agent, model, parts: [{ type: "text", text }] },
      })
      if (res.error) throw new Error(describe(res.error))
    },

    async abort({ sessionID, directory }) {
      await client.session.abort({ path: { id: sessionID }, query: { directory } })
    },

    async lastAssistant({ sessionID, directory }) {
      const res = await client.session.messages({ path: { id: sessionID }, query: { directory } })
      const messages = unwrap(res, "メッセージを取得できませんでした")
      const last = [...messages].reverse().find((m) => m.info.role === "assistant")
      if (!last || last.info.role !== "assistant") return undefined
      const info = last.info
      const text = last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")
      const result: AssistantResult = {
        text,
        providerID: info.providerID,
        modelID: info.modelID,
        tokens: info.tokens,
        cost: info.cost,
      }
      if (info.error) {
        const data = (info.error as { data?: { message?: unknown } }).data
        result.error = { name: info.error.name, message: typeof data?.message === "string" ? data.message : "" }
      }
      return result
    },
  }
}

function unwrap<T>(res: { data?: T; error?: unknown }, message: string): T {
  if (res.error !== undefined || res.data === undefined) throw new Error(`${message}: ${describe(res.error)}`)
  return res.data
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
