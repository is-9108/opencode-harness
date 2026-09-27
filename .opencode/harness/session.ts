// 工程の作業を、独立した子セッションで実行する（計画 4 章「子セッションの実行方法」）
// - 依頼は prompt_async で送る（応答を待つ HTTP は 5 分で切れる。M0-2）
// - 完了は session.idle のイベントと、状態の定期的な確認（poll）の早いほうで判定する。
//   worktree の子セッションは opencode の別のインスタンスで動き、そのイベントはこのプラグインに届かないため（#10 で判明）
// - prompt_async は受け付けた時点で成功を返し、失敗（エージェントが見つからないなど）は後から起きる。
//   開始の猶予を過ぎても子セッションが応答を始めなければ、エラーにする
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
  // 子セッションの状態と、最後のアシスタントのメッセージが完了しているか
  poll(input: { sessionID: string; directory: string }): Promise<PollResult>
}

export type PollResult = { status: "idle" | "busy" | "retry"; lastAssistantCompleted: boolean }

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
  pollMs?: number
  startGraceMs?: number
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
  // 子セッションの ID が決まった直後（完了を待つ前）に呼ばれる。工程はここで ID を保存し、
  // 途中で opencode ごと落ちても、次は同じ子セッションで続きから進められるようにする
  onSession?: (sessionID: string) => void
  signal?: AbortSignal
}

const PROGRESS_INTERVAL_MS = 15_000
const POLL_MS = 5_000
const START_GRACE_MS = 60_000

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
  opts.onSession?.(sessionID)

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
  const polling = { stopped: false }
  const polled = pollUntilDone(deps, { sessionID, directory: opts.directory, started }, polling)
  const outcome = await Promise.race([wait.promise, polled]).finally(() => {
    clearInterval(timer)
    polling.stopped = true
    wait.cancel()
  })

  if (outcome === "aborted") {
    await api.abort({ sessionID, directory: opts.directory }).catch(() => {})
    record("child.aborted", { sessionID })
    return { status: "aborted", sessionID }
  }

  const last = await api.lastAssistant({ sessionID, directory: opts.directory })
  if (outcome === "not_started" && !last?.error) {
    const error = `子セッションが始まりませんでした（${Math.round((deps.startGraceMs ?? START_GRACE_MS) / 1000)} 秒以内に応答がありません）。エージェント「${opts.agent}」が作業ディレクトリ ${opts.directory} の .opencode/agents にあるか、モデル ${opts.model} が使えるかを確認してください`
    record("child.error", { sessionID, error })
    return { status: "error", sessionID, error }
  }
  if (!last || last.error) {
    const error = last?.error ? `${last.error.name}: ${last.error.message}` : "子セッションの応答がありません"
    record("child.error", { sessionID, error, tokens: last?.tokens, cost: last?.cost })
    return { status: "error", sessionID, error }
  }
  const usedModel = `${last.providerID}/${last.modelID}`
  record("child.completed", { sessionID, tokens: last.tokens, cost: last.cost, model: usedModel })
  return { status: "completed", sessionID, text: last.text, tokens: last.tokens, cost: last.cost, model: usedModel }
}

// 状態を定期的に確かめ、完了（idle かつ最後のアシスタントのメッセージが完了）か、開始しなかったかを返す
async function pollUntilDone(
  deps: RunChildDeps,
  target: { sessionID: string; directory: string; started: number },
  polling: { stopped: boolean },
): Promise<"idle" | "not_started"> {
  const now = deps.now ?? Date.now
  const pollMs = deps.pollMs ?? POLL_MS
  const grace = deps.startGraceMs ?? START_GRACE_MS
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs))
    if (polling.stopped) return new Promise(() => {}) // もう一方で決着済み。この Promise は使われない
    try {
      const { status, lastAssistantCompleted } = await deps.api.poll({ sessionID: target.sessionID, directory: target.directory })
      if (status !== "idle") continue
      if (lastAssistantCompleted) return "idle"
      if (now() - target.started > grace) return "not_started"
    } catch {
      // 一時的な失敗は次の確認で取り返す
    }
  }
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
