// harness_status ツールが返す文章を組み立てる
import { CONFIG_FILE, type LoadResult } from "./config.ts"
import type { RunList, RunStatus } from "./state.ts"
import { formatBudgetWarning } from "./steps/budget.ts"

const STATUS_LABEL: Record<RunStatus, string> = {
  in_progress: "進行中",
  need_user: "ユーザーの対応待ち",
  escalated: "エスカレーション",
  interrupted: "中断",
  done: "完了",
}

// childSessions: run ごとに作った子セッションの数（予算の表示に使う。#40）
export function formatStatus(load: LoadResult, list: RunList = { runs: [], broken: [] }, childSessions: (runId: string) => number = () => 0): string {
  switch (load.status) {
    case "missing":
      return [
        `設定ファイル ${CONFIG_FILE} がありません（${load.path}）。`,
        `雛形 ${load.examplePath} をコピーして、モデル・チェック・テストファイルの場所を設定してください。`,
      ].join("\n")
    case "invalid":
      return [`設定ファイルに誤りがあります（${load.path}）:`, ...load.errors.map((e) => `- ${e}`)].join("\n")
    case "ok":
      return [
        ...formatRuns(list, childSessions, load.config.budget),
        ...(load.warnings.length > 0 ? ["", "設定の警告:", ...load.warnings.map((w) => `- ${w}`)] : []),
      ].join("\n")
  }
}

function formatRuns({ runs, broken }: RunList, childSessions: (runId: string) => number, budget: { maxChildSessionsPerIssue: number; warnAtRatio: number }): string[] {
  const lines: string[] = []
  const limit = budget.maxChildSessionsPerIssue
  if (runs.length === 0) lines.push("run はありません。")
  else {
    lines.push("| run | 種類 | 状態 | 工程 | 子セッション | 更新 |", "|---|---|---|---|---|---|")
    for (const r of runs) lines.push(`| ${r.id} | ${r.kind} | ${STATUS_LABEL[r.status]} | ${r.step} | ${childSessions(r.id)} / ${limit} | ${r.updatedAt} |`)
  }
  // 予算の 80% 以上を使った、まだ終わっていない run（#40）
  const warned = runs
    .filter((r) => r.status !== "done" && r.status !== "interrupted")
    .flatMap((r) => {
      const w = formatBudgetWarning(childSessions(r.id), limit, budget.warnAtRatio)
      return w ? [`- ${r.id}: ${w.replace(/^⚠ /, "")}`] : []
    })
  if (warned.length > 0) lines.push("", "予算の警告:", ...warned)
  // エスカレーションした run は、理由の種類と報告のパスを添える（#33）
  const escalated = runs.filter((r) => r.status === "escalated" && r.lastEscalation)
  if (escalated.length > 0)
    lines.push("", "エスカレーション:", ...escalated.map((r) => `- ${r.id}: ${r.lastEscalation!.reason}（報告: ${r.lastEscalation!.report}）`))
  if (broken.length > 0) lines.push("", "読み込めない run:", ...broken.map((b) => `- ${b.id}: ${b.error}`))
  return lines
}
