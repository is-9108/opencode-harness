// dev の run の状態機械（計画 8.2）。harness_advance から呼ばれ、現在の工程を 1 つだけ進める
import type { HarnessConfig } from "../config.ts"
import type { Exec } from "../exec.ts"
import type { ChildResult, RunChildOptions } from "../session.ts"
import type { Store } from "../state.ts"
import { runSetup } from "../steps/setup.ts"
import { recordPlan, runPlan, waitApproval } from "../steps/plan.ts"

export type StepDeps = {
  root: string
  config: HarnessConfig
  store: Store
  exec: Exec
  // 子セッションの実行。プラグイン側で親セッション・中断シグナル・記録先を結びつけて渡す
  child: (opts: Omit<RunChildOptions, "parentID" | "signal"> & { runId: string }) => Promise<ChildResult>
  now?: () => Date
}

// continue: もう一度 advance を呼べば次の工程に進む / need_user: ユーザーとの対話が必要
// escalated: 人に引き渡す / done: 完了 / error: 進められない（理由を message に書く）
export type StepResult = { kind: "continue" | "need_user" | "escalated" | "done" | "error"; message: string }

export type RecordInput = { run: string; gate: "plan"; decision: "approved" | "changes_requested" | "aborted"; feedback?: string }

export async function advance(deps: StepDeps, runId: string): Promise<StepResult> {
  const run = deps.store.get(runId)
  if (!run) return { kind: "error", message: `run ${runId} がありません。harness_start で作成してください` }
  if (run.status === "interrupted") return { kind: "error", message: `${runId} は中断されています` }
  switch (run.step) {
    case "setup":
      return runSetup(deps, run)
    case "plan":
      return runPlan(deps, run)
    case "approval":
      return waitApproval(run)
    default:
      return { kind: "error", message: `工程 ${run.step} はまだ実装されていません` }
  }
}

export function record(deps: StepDeps, input: RecordInput): StepResult {
  const run = deps.store.get(input.run)
  if (!run) return { kind: "error", message: `run ${input.run} がありません` }
  switch (input.gate) {
    case "plan":
      return recordPlan(deps, run, input)
  }
}
