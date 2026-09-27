// テスト用の偽の SessionApi。呼び出しを記録し、応答の仕方をテストごとに差し替えられる
import type { AssistantResult, EventBus, PollResult, SessionApi } from "../session.ts"

export type FakeCall =
  | { op: "create"; parentID?: string; title: string; directory: string; permission?: unknown }
  | { op: "promptAsync"; sessionID: string; directory: string; agent: string; model: { providerID: string; modelID: string }; text: string }
  | { op: "abort"; sessionID: string }

export function createFakeApi(bus: EventBus, opts: {
  // promptAsync が呼ばれたときの振る舞い。既定では、次のティックで idle を通知する
  onPrompt?: (sessionID: string, emitIdle: () => void) => void
  result?: AssistantResult | ((sessionID: string) => AssistantResult | undefined)
  promptError?: Error
  // 状態の確認（poll）の応答。既定では「作業中」を返し、完了の判定はイベントに任せる
  poll?: (sessionID: string, count: number) => PollResult
} = {}) {
  const calls: FakeCall[] = []
  let seq = 0
  let pollCount = 0
  const emitIdle = (sessionID: string) => () => bus.emit({ type: "session.idle", properties: { sessionID } })
  const api: SessionApi = {
    async create(input) {
      calls.push({ op: "create", ...input })
      return { id: `ses_fake_${++seq}` }
    },
    async promptAsync(input) {
      calls.push({ op: "promptAsync", ...input })
      if (opts.promptError) throw opts.promptError
      const onPrompt = opts.onPrompt ?? ((_id, idle) => setTimeout(idle, 0))
      onPrompt(input.sessionID, emitIdle(input.sessionID))
    },
    async abort(input) {
      calls.push({ op: "abort", sessionID: input.sessionID })
    },
    async poll(input) {
      pollCount++
      return opts.poll ? opts.poll(input.sessionID, pollCount) : { status: "busy", lastAssistantCompleted: false }
    },
    async lastAssistant(input) {
      const r = opts.result ?? defaultResult()
      return typeof r === "function" ? r(input.sessionID) : r
    },
  }
  return { api, calls }
}

export const defaultResult = (): AssistantResult => ({
  text: "done",
  providerID: "openai",
  modelID: "gpt-6-luna",
  tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
})

// シェルのコマンドを実行しない工程のテストで使う。呼ばれたら失敗させる
export const noShell = async (): Promise<never> => {
  throw new Error("この工程ではシェルのコマンドは呼ばれないはず")
}

// どのコマンドも成功で返す偽のシェル（setup のベースラインで checks を実行するため）。呼ばれたコマンドを記録する
export const okShell = (calls: { command: string; cwd: string }[] = []) =>
  async (command: string, o: { cwd: string }) => {
    calls.push({ command, cwd: o.cwd })
    return { code: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }
  }
