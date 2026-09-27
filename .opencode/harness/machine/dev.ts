// dev の run の状態機械（計画 8.2）。harness_advance から呼ばれ、現在の工程を 1 つだけ進める
import type { HarnessConfig } from "../config.ts"
import type { Exec } from "../exec.ts"
import type { Store } from "../state.ts"
import { runSetup } from "../steps/setup.ts"

export type StepDeps = {
  root: string
  config: HarnessConfig
  store: Store
  exec: Exec
  now?: () => Date
}

// continue: もう一度 advance を呼べば次の工程に進む / need_user: ユーザーとの対話が必要
// escalated: 人に引き渡す / done: 完了 / error: 進められない（理由を message に書く）
export type StepResult = { kind: "continue" | "need_user" | "escalated" | "done" | "error"; message: string }

export async function advance(deps: StepDeps, runId: string): Promise<StepResult> {
  const run = deps.store.get(runId)
  if (!run) return { kind: "error", message: `run ${runId} がありません。harness_start で作成してください` }
  switch (run.step) {
    case "setup":
      return runSetup(deps, run)
    default:
      return { kind: "error", message: `工程 ${run.step} はまだ実装されていません` }
  }
}
