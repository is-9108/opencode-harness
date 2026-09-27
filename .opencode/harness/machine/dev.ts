// dev の run の状態機械（計画 8.2）。harness_advance から呼ばれ、現在の工程を 1 つだけ進める
import type { HarnessConfig } from "../config.ts"
import type { Exec, Shell } from "../exec.ts"
import type { ChildResult, RunChildOptions } from "../session.ts"
import type { RunState, Store } from "../state.ts"
import { recordDependency, runSetup } from "../steps/setup.ts"
import { recordPlan, runPlan, waitApproval } from "../steps/plan.ts"
import { runRed } from "../steps/red.ts"
import { runGreen } from "../steps/green.ts"
import { runChecks } from "../steps/checks.ts"
import { runReview } from "../steps/review.ts"
import { runPr } from "../steps/pr.ts"
import { auditAfterStep } from "../steps/audit.ts"
import { fixGuide } from "../steps/escalation.ts"

export type StepDeps = {
  root: string
  config: HarnessConfig
  store: Store
  exec: Exec
  // checks に書かれたコマンドの実行（シェル経由）
  shell: Shell
  // 子セッションの実行。プラグイン側で親セッション・中断シグナル・記録先を結びつけて渡す
  child: (opts: Omit<RunChildOptions, "parentID" | "signal"> & { runId: string }) => Promise<ChildResult>
  now?: () => Date
}

// continue: もう一度 advance を呼べば次の工程に進む / need_user: ユーザーとの対話が必要
// escalated: 人に引き渡す / done: 完了 / error: 進められない（理由を message に書く）
export type StepResult = { kind: "continue" | "need_user" | "escalated" | "done" | "error"; message: string }

export type RecordInput =
  | { run: string; gate: "plan"; decision: "approved" | "changes_requested" | "aborted"; feedback?: string }
  | { run: string; gate: "dependency"; decision: "wait" | "stack" | "ignore" }

// ゲートごとに記録できる判断
const DECISIONS: Record<RecordInput["gate"], readonly string[]> = {
  plan: ["approved", "changes_requested", "aborted"],
  dependency: ["wait", "stack", "ignore"],
}

export async function advance(deps: StepDeps, runId: string): Promise<StepResult> {
  const run = deps.store.get(runId)
  if (!run) return { kind: "error", message: `run ${runId} がありません。harness_start で作成してください` }
  if (run.status === "done") return { kind: "done", message: `${runId} は完了しています${run.prUrl ? `（PR: ${run.prUrl}）` : ""}` }
  if (run.status === "interrupted") return { kind: "error", message: `${runId} は中断されています` }
  if (run.status === "escalated") {
    const last = run.lastEscalation
    const detail = last ? `（${last.reason}）。報告: ${last.report}` : ""
    return { kind: "escalated", message: `${runId} はエスカレーションされています（工程: ${run.step}）${detail}\n${fixGuide(run)}` }
  }
  const result = await runStep(deps, run)
  // テストがロックされた後の工程では、工程が終わるたびにテストファイルを監査する（#12）
  return run.redCommit && AUDITED_STEPS.has(run.step) ? auditAfterStep(deps, run, result) : result
}

// red より後の、テスト以外のコードを変える工程
const AUDITED_STEPS = new Set(["green", "checks", "review", "pr"])

async function runStep(deps: StepDeps, run: RunState): Promise<StepResult> {
  switch (run.step) {
    case "setup":
      return runSetup(deps, run)
    case "plan":
      return runPlan(deps, run)
    case "approval":
      return waitApproval(run)
    case "red":
      return runRed(deps, run)
    case "green":
      return runGreen(deps, run)
    case "checks":
      return runChecks(deps, run)
    case "review":
      return runReview(deps, run)
    case "pr":
      return runPr(deps, run)
    default:
      return { kind: "error", message: `工程 ${run.step} はまだ実装されていません` }
  }
}

export function record(deps: StepDeps, input: RecordInput): StepResult {
  const run = deps.store.get(input.run)
  if (!run) return { kind: "error", message: `run ${input.run} がありません` }
  if (!DECISIONS[input.gate]?.includes(input.decision))
    return { kind: "error", message: `ゲート ${input.gate} には、判断 ${input.decision} を記録できません（記録できるもの: ${DECISIONS[input.gate]?.join(" / ") ?? "なし"}）` }
  switch (input.gate) {
    case "plan":
      return recordPlan(deps, run, input)
    case "dependency":
      return recordDependency(deps, run, input)
  }
}
