// review-fix の工程（計画 8.2、8.3、#37）
// review で blocking の指摘があれば、review-fixer に blocking の指摘だけを直させ、記録を review-fix/<k>.md に書かせてから checks に戻す。
// 回数（reviewFix、autoFixUsed）は、review から review-fix に入る前に加算して保存する（強制終了で二重に数えない）
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import { enforceLock } from "./audit.ts"
import { runDir } from "./common.ts"
import { planPath } from "./plan.ts"
import { checkpoint } from "./red.ts"
import { decisionsPath } from "./spec-gap.ts"
import { fixerPermissions, isRecordDone } from "./test-fix.ts"

const MODEL_KEYS = ["dev.review-fix", "dev.test-fix", "dev.implementer"]
const SECTIONS = ["対応", "修正"]

export const reviewFixDir = (worktree: string) => join(runDir(worktree), "review-fix")
const recordPath = (worktree: string, k: number) => join(reviewFixDir(worktree), `${k}.md`)

export async function runReviewFix(deps: StepDeps, run: RunState): Promise<StepResult> {
  const worktree = run.worktree
  if (!worktree) return { kind: "error", message: "worktree が記録されていません。setup からやり直してください" }
  const model = MODEL_KEYS.map((k) => deps.config.models[k]?.[0]).find(Boolean)
  if (!model) return { kind: "error", message: `harness.config.json の models に「dev.review-fix」（または dev.test-fix、dev.implementer）がありません` }

  const k = run.reviewFix ?? 1
  const record = recordPath(worktree, k)
  const key = `review-fix-${k}`
  const summary = join(runDir(worktree), "reviews", `round-${run.reviewRounds ?? 1}`, "summary.md")

  if (!isRecordDone(record, SECTIONS)) {
    const permission = fixerPermissions(worktree, deps, `*review-fix?${k}.md`)
    const common = { runId: run.id, directory: worktree, title: `${run.id}: review-fix ${k}`, agent: "review-fixer", model, permission }
    const resuming = run.sessions?.[key]
    const save = (sessionID: string) => {
      const latest = deps.store.get(run.id) ?? run
      deps.store.save({ ...latest, sessions: { ...latest.sessions, [key]: sessionID } })
    }
    const first = await deps.child({ ...common, sessionID: resuming, onSession: save, prompt: resuming ? resumePrompt(record) : initialPrompt(worktree, record, summary, k) })
    if (first.status === "aborted") return { kind: "error", message: "review-fix の子セッションが中断されました。harness_advance で、同じ子セッションの続きから再開できます" }
    if (first.status === "error") return { kind: "error", message: `review-fix の子セッションがエラーで終わりました: ${first.error}` }
    // 記録の書き忘れは、同じセッションに 1 回だけ直させる
    if (!isRecordDone(record, SECTIONS)) {
      const retry = await deps.child({ ...common, sessionID: first.sessionID, prompt: recordPrompt(record) })
      if (retry.status !== "completed" || !isRecordDone(record, SECTIONS))
        return { kind: "error", message: `review-fix の記録（${record}）が完成していません。frontmatter の status: done と「## 対応」「## 修正」が必要です` }
    }
  }

  // commit の前にテストのロックを照合する。変更されていたら元に戻し、この周は失敗として checks に戻す
  const violated = await enforceLock(deps, run)
  if (violated) {
    deps.store.save({ ...(deps.store.get(run.id) ?? run), step: "checks" })
    return { kind: "continue", message: `${violated.message}\nreview-fix の ${k} 回目は失敗として扱い、checks に戻ります` }
  }
  const commit = await checkpoint(deps, worktree, `fix: #${run.issue} のレビューの指摘を直す（review-fix ${k}）`)
  if (typeof commit !== "string") return commit
  deps.store.save({ ...(deps.store.get(run.id) ?? run), step: "checks" })
  deps.store.appendEvent(run.id, { type: "step.completed", step: "review-fix", k, commit })
  return { kind: "continue", message: `review-fix の ${k} 回目が完了しました（記録: ${record}）。commit ${commit.slice(0, 7)}。次の工程: checks` }
}

// これまでの review-fix の記録（エスカレーションの報告の「試した修正」に載せる）
export function reviewFixAttempts(worktree: string): string[] {
  const dir = reviewFixDir(worktree)
  if (!worktree || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^\d+\.md$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b))
    .map((f) => {
      const done = readFileSync(join(dir, f), "utf8").match(/^##\s*修正\s*\n+(.+)$/m)?.[1]?.trim() ?? "（修正の記録なし）"
      return `${join(dir, f)}: ${done}`
    })
}

function initialPrompt(worktree: string, record: string, summary: string, k: number): string {
  return [
    `レビューで blocking の指摘がありました。blocking の指摘だけを直してください（review-fix の ${k} 回目）。`,
    "",
    `- レビューの集計: ${summary}（「## blocking（ループの対象）」の欄だけが対象。ほかの欄の指摘には対応しない）`,
    `- issue: ${join(runDir(worktree), "00-issue.md")}（受け入れ基準が仕様の正）`,
    `- 計画: ${planPath(worktree)}`,
    ...(existsSync(decisionsPath(worktree)) ? [`- 仕様の確認の記録: ${decisionsPath(worktree)}（ユーザーが決めた解釈。受け入れ基準と合わせて仕様の正とする）`] : []),
    ...(k > 1 ? [`- これまでの review-fix の記録: ${reviewFixDir(worktree)}（一度直した指摘を、別の指摘を直すために元に戻さない）`] : []),
    "",
    "手順:",
    `1. ${record} を作り、frontmatter を status: in_progress にする`,
    "2. blocking の指摘ごとに、指摘の根拠（AC とファイル:行）を読み、受け入れ基準に合うように実装を直す",
    "3. テストを実行して、既存のテストが壊れていないことを確かめる",
    "4. 「## 対応」に指摘の ID ごとの対応（直した / 直さなかった理由）を、「## 修正」に何をどう直したかを書き、frontmatter を status: done にする",
    "",
    "守ること:",
    "- テストファイルは編集できない（ロックされている）。テストを変えずに、実装だけで直す",
    "- blocking ではない指摘や、指摘のない箇所には手を入れない（ついでのリファクタリングもしない）",
    "- テストに合わせた特別扱い（値のハードコード、テスト専用の分岐）はしない",
  ].join("\n")
}

function resumePrompt(record: string): string {
  return `中断されたので、${record} と作業ツリーの状態（git status / git diff）を確認して、続きを進めてください。終えたら ${record} の frontmatter を status: done にしてください。`
}

function recordPrompt(record: string): string {
  return `${record} が完成していません。「## 対応」と「## 修正」に中身を書き、frontmatter を status: done にしてください。`
}
