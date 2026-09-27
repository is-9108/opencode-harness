// 工程の作業を、独立した子セッションで実行する（計画 4 章「子セッションの実行方法」）
// - 依頼は prompt_async で送り、完了は session.idle のイベントで受け取る（応答を待つ HTTP は 5 分で切れる。M0-2）
// - 親のツールが中断されたら、子セッションにも abort を送る。完了した後に届いた abort は無視する（M0-2）
// - エラーの再試行やモデルの切り替えはしない（上限の検知とフォールバックは M3）

export type ModelRef = { providerID: string; modelID: string }
export type PermissionRule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }
export type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

export type AssistantResult = {
  text: string
  providerID: string
  modelID: string
  tokens: Tokens
  cost: number
  error?: { name: string; message: string }
}

// SDK のうち、ハーネスが使う部分だけのインターフェイス。実装は sdk-adapter.ts、テストでは偽物を使う
export interface SessionApi {
  create(input: { parentID?: string; title: string; directory: string; permission?: PermissionRule[] }): Promise<{ id: string }>
  promptAsync(input: { sessionID: string; directory: string; agent: string; model: ModelRef; text: string }): Promise<void>
  abort(input: { sessionID: string; directory: string }): Promise<void>
  lastAssistant(input: { sessionID: string; directory: string }): Promise<AssistantResult | undefined>
}

export type BusEvent = { type: string; properties?: Record<string, unknown> }

export interface EventBus {
  emit(event: BusEvent): void
  // 依頼を送る前に呼び、取りこぼしを防ぐ。idle が先なら "idle"、中断が先なら "aborted" で解決する
  waitForIdle(sessionID: string, signal?: AbortSignal): { promise: Promise<"idle" | "aborted">; cancel(): void }
}

export type ChildEvent = {
  type: "child.completed" | "child.error" | "child.aborted"
  sessionID?: string
  title: string
  agent: string
  model: string
  durationMs: number
  tokens?: Tokens
  cost?: number
  error?: string
}

export type ChildResult =
  | { status: "completed"; sessionID: string; text: string; tokens: Tokens; cost: number; model: string }
  | { status: "error"; sessionID?: string; error: string }
  | { status: "aborted"; sessionID?: string }

export type RunChildDeps = {
  api: SessionApi
  events: EventBus
  log: (event: ChildEvent) => void
  progress?: (message: string) => void
  now?: () => number
}

export type RunChildOptions = {
  parentID?: string
  directory: string
  title: string
  agent: string
  model: string
  prompt: string
  permission?: PermissionRule[]
  // 指定すると、新しく作らずにこのセッションへ続きを送る
  sessionID?: string
  signal?: AbortSignal
}

const PROGRESS_INTERVAL_MS = 15_000

export function parseModel(ref: string): ModelRef {
  const i = ref.indexOf("/")
  if (i <= 0 || i === ref.length - 1 || /\s/.test(ref)) throw new Error(`モデルは provider/model の形式で指定してください: ${ref}`)
  return { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) }
}

export async function runChild(deps: RunChildDeps, opts: RunChildOptions): Promise<ChildResult> {
  const { api, events, log } = deps
  const now = deps.now ?? Date.now
  const model = parseModel(opts.model)
  const started = now()
  const record = (type: ChildEvent["type"], extra: Partial<ChildEvent>) =>
    log({ type, title: opts.title, agent: opts.agent, model: opts.model, durationMs: now() - started, ...extra })

  if (opts.signal?.aborted) {
    record("child.aborted", { sessionID: opts.sessionID })
    return { status: "aborted", sessionID: opts.sessionID }
  }

  const sessionID =
    opts.sessionID ??
    (await api.create({ parentID: opts.parentID, title: opts.title, directory: opts.directory, permission: opts.permission })).id

  const wait = events.waitForIdle(sessionID, opts.signal)
  try {
    await api.promptAsync({ sessionID, directory: opts.directory, agent: opts.agent, model, text: opts.prompt })
  } catch (e) {
    wait.cancel()
    const error = `依頼を送れませんでした: ${(e as Error).message}`
    record("child.error", { sessionID, error })
    return { status: "error", sessionID, error }
  }

  deps.progress?.(`${opts.title}: ${opts.agent}（${opts.model}）が作業中`)
  const timer = setInterval(
    () => deps.progress?.(`${opts.title}: ${opts.agent}（${opts.model}）が作業中 — ${Math.round((now() - started) / 1000)} 秒経過`),
    PROGRESS_INTERVAL_MS,
  )
  timer.unref?.()
  const outcome = await wait.promise.finally(() => clearInterval(timer))

  if (outcome === "aborted") {
    await api.abort({ sessionID, directory: opts.directory }).catch(() => {})
    record("child.aborted", { sessionID })
    return { status: "aborted", sessionID }
  }

  const last = await api.lastAssistant({ sessionID, directory: opts.directory })
  if (!last || last.error) {
    const error = last?.error ? `${last.error.name}: ${last.error.message}` : "子セッションの応答がありません"
    record("child.error", { sessionID, error, tokens: last?.tokens, cost: last?.cost })
    return { status: "error", sessionID, error }
  }
  const usedModel = `${last.providerID}/${last.modelID}`
  record("child.completed", { sessionID, tokens: last.tokens, cost: last.cost, model: usedModel })
  return { status: "completed", sessionID, text: last.text, tokens: last.tokens, cost: last.cost, model: usedModel }
}

export function createEventBus(): EventBus {
  const waiters = new Map<string, Set<() => void>>()
  return {
    emit(event) {
      if (event.type !== "session.idle") return
      const sessionID = event.properties?.sessionID
      if (typeof sessionID !== "string") return
      for (const resolve of [...(waiters.get(sessionID) ?? [])]) resolve()
    },
    waitForIdle(sessionID, signal) {
      let cancel = () => {}
      const promise = new Promise<"idle" | "aborted">((resolve) => {
        const set = waiters.get(sessionID) ?? new Set()
        waiters.set(sessionID, set)
        const cleanup = () => {
          set.delete(onIdle)
          if (set.size === 0) waiters.delete(sessionID)
          signal?.removeEventListener("abort", onAbort)
        }
        const onIdle = () => (cleanup(), resolve("idle"))
        const onAbort = () => (cleanup(), resolve("aborted"))
        set.add(onIdle)
        signal?.addEventListener("abort", onAbort, { once: true })
        cancel = cleanup
      })
      return { promise, cancel }
    },
  }
}
