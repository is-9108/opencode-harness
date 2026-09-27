// run の状態の保存（計画 7 章）。state.json は一時ファイルに書いてから rename し、途中で落ちても壊れないようにする
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

export type RunKind = "dev"
export type RunStatus = "in_progress" | "need_user" | "escalated" | "interrupted" | "done"

export type RunState = {
  id: string
  kind: RunKind
  issue: number
  status: RunStatus
  step: string
  createdAt: string
  updatedAt: string
  // setup の工程で決まる
  title?: string
  worktree?: string
  branch?: string
  // 依存先の issue の確認（#31）。開いている依存先と、積む先の候補のブランチ、ユーザーの判断
  pendingDependencies?: number[]
  stackCandidate?: string
  dependencyDecision?: "stack" | "ignore"
  // 依存先の issue のブランチに積んだときの基準のブランチ。なければ設定の git.baseBranch（差分と PR の base に使う）
  baseBranch?: string
  // 工程ごとの子セッションの ID（修正指示や再開のときに、同じセッションへ続きを送るため）
  sessions?: Record<string, string>
  // ユーザーの修正指示のうち、まだ子セッションに送っていないもの
  feedback?: string
  feedbackCount?: number
  // red の検証に合格したときの commit（テストのロックと、後の差分の基準）
  redCommit?: string
  // green の完了時の commit
  greenCommit?: string
  // checks を実行した回数（checks/run-<n>.md の n）
  checksRuns?: number
  // 失敗した checks の指紋の履歴（#34）。同じ指紋が続いたら進んでいないとみなす（#35）
  fingerprints?: string[]
  // test-fix の回数（/fix で 0 に戻す）と、自動の修正（test-fix と review-fix）の合計。工程に入る前に加算する（#35）
  testFix?: number
  autoFixUsed?: number
  // テストの変更申請（#36）。判断を待っている申請と、却下されて test-fix に伝える申請
  pendingChangeRequest?: string
  rejectedChangeRequest?: string
  // review を実行した回数（reviews/round-<n>/ の n）と、最後にレビューした commit（2 周目以降の差分の基準）
  reviewRounds?: number
  reviewedCommit?: string
  // review-fix の回数（リセットしない）と、blocking の指摘の ID ごとに、出た周の履歴（再発の検知に使う。#37）
  reviewFix?: number
  findingRounds?: Record<string, number[]>
  // spec_gap（#38）。回答を待っている曖昧な点（先頭から 1 件ずつ聞く）、すべて答えた後に続ける review-fix の入力、回答済みの ID
  pendingSpecGaps?: SpecGap[]
  specGapFollowUp?: { blocking: Finding[]; recurred: Finding[]; summary: string }
  answeredGaps?: string[]
  // human: エスカレーションの後。以降は review-fix を自動で実行しない（戻さない。計画 8.3）
  mode?: "auto" | "human"
  // エスカレーションした回数と、最後のエスカレーション（#33）
  escalations?: number
  lastEscalation?: { number: number; reason: string; report: string }
  // pr の工程で作成・更新した PR
  prNumber?: number
  prUrl?: string
}

// レビューの指摘（steps/review.ts の Finding と同じ形。state.ts が工程のモジュールに依存しないよう、ここで定義する）
export type Finding = { id: string; key: string; category: string; blocking: boolean; ac: string; evidence: string; content: string }
export type SpecGap = { id: string; key: string; ac: string; content: string; options: string[]; round: number }

export type RunList = { runs: RunState[]; broken: { id: string; error: string }[] }

export type Store = {
  get(id: string): RunState | undefined
  list(): RunList
  save(run: RunState): RunState
  appendEvent(id: string, event: Record<string, unknown>): void
}

const STATE_FILE = "state.json"
const EVENTS_FILE = "events.jsonl"
// Windows ではウイルス対策ソフトなどが一時的にファイルを掴み、rename が EPERM / EBUSY で失敗することがある
const RENAME_RETRIES = 5

export function runIdFor(input: { kind: RunKind; issue: number }): string {
  return `issue-${input.issue}`
}

export function createStore(root: string, now: () => Date = () => new Date()): Store {
  const runsDir = join(root, ".harness", "runs")
  const runDir = (id: string) => join(runsDir, id)

  const read = (id: string): RunState | undefined => {
    const path = join(runDir(id), STATE_FILE)
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, "utf8")) as RunState
  }

  const store: Store = {
    get: read,

    list() {
      if (!existsSync(runsDir)) return { runs: [], broken: [] }
      const result: RunList = { runs: [], broken: [] }
      for (const id of readdirSync(runsDir)) {
        try {
          const run = read(id)
          if (run) result.runs.push(run)
        } catch (e) {
          result.broken.push({ id, error: `state.json を読み込めません: ${(e as Error).message}` })
        }
      }
      result.runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return result
    },

    save(run) {
      const updatedAt = now().toISOString()
      const saved = { ...run, createdAt: run.createdAt || updatedAt, updatedAt }
      const dir = runDir(run.id)
      mkdirSync(dir, { recursive: true })
      const tmp = join(dir, `${STATE_FILE}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`)
      writeFileSync(tmp, JSON.stringify(saved, null, 2))
      try {
        renameWithRetry(tmp, join(dir, STATE_FILE))
      } catch (e) {
        rmSync(tmp, { force: true })
        throw e
      }
      return saved
    },

    appendEvent(id, event) {
      mkdirSync(runDir(id), { recursive: true })
      appendFileSync(join(runDir(id), EVENTS_FILE), JSON.stringify({ t: now().toISOString(), ...event }) + "\n")
    },
  }
  return store
}

export function startRun(store: Store, input: { kind: RunKind; issue: number }): { run: RunState; created: boolean } {
  if (!Number.isInteger(input.issue) || input.issue <= 0) throw new Error(`issue 番号は正の整数である必要があります: ${input.issue}`)
  const id = runIdFor(input)
  const existing = store.get(id)
  if (existing) return { run: existing, created: false }
  // createdAt と updatedAt は save が埋める
  const run = store.save({ id, kind: input.kind, issue: input.issue, status: "in_progress", step: "setup", createdAt: "", updatedAt: "" })
  store.appendEvent(id, { type: "run.created", kind: input.kind, issue: input.issue })
  return { run, created: true }
}

function renameWithRetry(from: string, to: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY")) throw e
      const until = Date.now() + 20 * attempt
      while (Date.now() < until) {
        // 同期 API の中なので、短い待ちはビジーウェイトで行う
      }
    }
  }
}
