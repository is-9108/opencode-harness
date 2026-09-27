// harness_status ツールが返す文章を組み立てる
import { CONFIG_FILE, type LoadResult } from "./config.ts"
import type { RunList, RunStatus } from "./state.ts"

const STATUS_LABEL: Record<RunStatus, string> = {
  in_progress: "進行中",
  need_user: "ユーザーの対応待ち",
  escalated: "エスカレーション",
  interrupted: "中断",
  done: "完了",
}

export function formatStatus(load: LoadResult, list: RunList = { runs: [], broken: [] }): string {
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
        ...formatRuns(list),
        ...(load.warnings.length > 0 ? ["", "設定の警告:", ...load.warnings.map((w) => `- ${w}`)] : []),
      ].join("\n")
  }
}

function formatRuns({ runs, broken }: RunList): string[] {
  const lines: string[] = []
  if (runs.length === 0) lines.push("run はありません。")
  else {
    lines.push("| run | 種類 | 状態 | 工程 | 更新 |", "|---|---|---|---|---|")
    for (const r of runs) lines.push(`| ${r.id} | ${r.kind} | ${STATUS_LABEL[r.status]} | ${r.step} | ${r.updatedAt} |`)
  }
  // エスカレーションした run は、理由の種類と報告のパスを添える（#33）
  const escalated = runs.filter((r) => r.status === "escalated" && r.lastEscalation)
  if (escalated.length > 0)
    lines.push("", "エスカレーション:", ...escalated.map((r) => `- ${r.id}: ${r.lastEscalation!.reason}（報告: ${r.lastEscalation!.report}）`))
  if (broken.length > 0) lines.push("", "読み込めない run:", ...broken.map((b) => `- ${b.id}: ${b.error}`))
  return lines
}
