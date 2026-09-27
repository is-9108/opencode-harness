// 予算（計画 8.3、#40）。M2 では、issue ごとに作った子セッションの数を数える（トークンとコストは M3）。
// 新しい子セッションを作る前に events.jsonl に child.created を記録し、その数で判定する。
// state.json ではなく記録で数えるのは、工程が古い run を保存し直しても、数が巻き戻らないようにするため
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { Store } from "../state.ts"
import { escalate } from "./escalation.ts"

export class BudgetExceeded extends Error {
  readonly used: number
  readonly limit: number
  readonly title: string
  constructor(used: number, limit: number, title: string) {
    super(`子セッションの数が上限（${limit}）に達しました`)
    this.used = used
    this.limit = limit
    this.title = title
  }
}

export const childSessionsUsed = (store: Store, runId: string) => store.events(runId).filter((e) => e.type === "child.created").length

// 子セッションの実行を包み、新しい子セッションを作る前に上限を確かめる。
// 既存の子セッションに続きを送る（sessionID がある）ときは、新しい子セッションとして数えない
export function budgetedChild(deps: StepDeps): StepDeps["child"] {
  return async (opts) => {
    if (!opts.sessionID) {
      const used = childSessionsUsed(deps.store, opts.runId)
      const limit = deps.config.budget.maxChildSessionsPerIssue
      if (used >= limit) throw new BudgetExceeded(used, limit, opts.title)
      deps.store.appendEvent(opts.runId, { type: "child.created", n: used + 1, title: opts.title, agent: opts.agent })
    }
    return deps.child(opts)
  }
}

// 上限に達して子セッションを作らなかったときのエスカレーション
export async function escalateBudget(deps: StepDeps, runId: string, e: BudgetExceeded): Promise<StepResult> {
  const run = deps.store.get(runId)
  if (!run) return { kind: "error", message: `run ${runId} がありません` }
  deps.store.appendEvent(runId, { type: "budget.exceeded", used: e.used, limit: e.limit, title: e.title })
  return escalate(deps, run, {
    reason: "budget",
    summary: `子セッションの数が上限 budget.maxChildSessionsPerIssue（${e.limit} 個）に達したため、「${e.title}」の子セッションを作らずに止めました。`,
    history: [`作った子セッション: ${e.used} 個`],
    open: ["このまま直すか（/fix）、上限を見直すか"],
  })
}

// 上限の warnAtRatio（既定 80%）以上を使っていれば、警告の文を返す
export function budgetWarning(deps: Pick<StepDeps, "config" | "store">, runId: string): string | undefined {
  const used = childSessionsUsed(deps.store, runId)
  return formatBudgetWarning(used, deps.config.budget.maxChildSessionsPerIssue, deps.config.budget.warnAtRatio)
}

export function formatBudgetWarning(used: number, limit: number, ratio: number): string | undefined {
  if (used < limit * ratio) return undefined
  return `⚠ 予算: 子セッションを ${used} / ${limit} 個使いました（${Math.round(ratio * 100)}% 以上）。上限に達すると、新しい子セッションを作らずにエスカレーションします`
}
