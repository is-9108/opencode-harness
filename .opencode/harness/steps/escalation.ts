// エスカレーション（計画 8.3 の mode、8.5、#33）。止まった理由と経緯を報告にまとめ、run を人に引き渡す。
// エスカレーションした run は human モードにし、戻さない（human モードでは review-fix を自動で実行しない）
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import { baseBranchOf, runDir } from "./common.ts"

export type EscalationReason =
  | "loop_exhausted" // ループの上限に達した
  | "no_progress" // 同じ失敗の指紋が続いた
  | "oscillation" // 一度解消した指摘が再び出た
  | "budget" // 予算を超えた
  | "test_change_request" // テストの変更申請があった
  | "dependency" // 依存の追加
  | "safety" // 秘密情報や safety_critical の指摘
  | "issue_changed" // 開発中に issue の本文が変わった

export type Escalation = {
  reason: EscalationReason
  // 何が起きて止まったかの 1〜2 文
  summary: string
  // 止まるまでの経緯（工程ごとの出来事）
  history?: string[]
  // 試した修正（修正の記録ファイルなど）
  attempts?: string[]
  // 人に判断してほしいこと（残っている失敗や指摘など）
  open?: string[]
}

export async function escalate(deps: StepDeps, run: RunState, e: Escalation): Promise<StepResult> {
  const number = (run.escalations ?? 0) + 1
  const dir = run.worktree ? runDir(run.worktree) : join(deps.root, ".harness", "runs", run.id)
  mkdirSync(dir, { recursive: true })
  const report = join(dir, `escalation-${number}.md`)

  // 報告を先に書き、その後で状態を保存する。間で落ちても、再実行で同じ番号の報告を書き直す
  const text = render(number, run, e, await diffStat(deps, run), (deps.now?.() ?? new Date()).toISOString())
  const tmp = `${report}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, report)

  deps.store.save({ ...run, status: "escalated", mode: "human", escalations: number, lastEscalation: { number, reason: e.reason, report } })
  deps.store.appendEvent(run.id, { type: "escalation.created", number, reason: e.reason, report, step: run.step })
  return { kind: "escalated", message: [`エスカレーションしました（${e.reason}）: ${e.summary}`, `報告: ${report}`, fixGuide(run)].join("\n") }
}

export const fixGuide = (run: RunState) => `/fix ${run.issue} で、報告をもとに対話しながら直せます。`

async function diffStat(deps: StepDeps, run: RunState): Promise<string> {
  if (!run.worktree) return "（worktree がまだないため、差分はありません）"
  const r = await deps.exec("git", ["diff", "--shortstat", `${baseBranchOf(deps.config, run)}...HEAD`, "--", ".", ":(exclude).opencode"], { cwd: run.worktree })
  if (r.code !== 0) return `（取得できませんでした: ${r.stderr.trim()}）`
  return r.stdout.trim() || "（変更なし）"
}

function render(number: number, run: RunState, e: Escalation, diff: string, at: string): string {
  const list = (items: string[] | undefined) => (items?.length ? items.map((i) => `- ${i}`) : ["- なし"])
  return [
    "---",
    `escalation: ${number}`,
    `reason: ${e.reason}`,
    `step: ${run.step}`,
    `at: ${at}`,
    "---",
    `# エスカレーション ${number}（issue #${run.issue}、工程: ${run.step}）`,
    "",
    e.summary,
    "",
    "## 止まるまでの経緯",
    "",
    ...list(e.history),
    `- 実行した回数: checks ${run.checksRuns ?? 0} 回、review ${run.reviewRounds ?? 0} 回、計画の修正指示 ${run.feedbackCount ?? 0} 回`,
    "",
    "## 試した修正",
    "",
    ...list(e.attempts),
    "",
    "## diff の統計",
    "",
    `- ${diff}（.opencode を除く）`,
    "",
    "## 未解決の論点",
    "",
    ...list(e.open),
    "",
    "## 次にできること",
    "",
    `- ${fixGuide(run)}`,
    "",
  ].join("\n")
}
