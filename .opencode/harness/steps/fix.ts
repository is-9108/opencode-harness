// /fix（計画 8.6、#41）。エスカレーションした run を、司令塔 harness-fix がユーザーと対話しながら直す。
// harness_start(kind: "fix") で報告の要約と方針の選択肢を返し、harness-fix が直して fix-<e>.md を書いたら、
// harness_advance で commit して checks → review（human モード）に戻す。testFix の回数は 0 から数え直す
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import { runIdFor, type RunState } from "../state.ts"
import { enforceLock } from "./audit.ts"
import { baseBranchOf, runDir } from "./common.ts"
import { planPath } from "./plan.ts"
import { checkpoint } from "./red.ts"
import { changeRequestDir, findPendingRequest, handleChangeRequest, pendingDecision } from "./test-change.ts"
import { isRecordDone, testFixDir } from "./test-fix.ts"
import { reviewFixDir } from "./review-fix.ts"
import { waiversPath } from "./waiver.ts"

const SECTIONS = ["方針", "修正"]
const REVIEW_STEPS = new Set(["review", "review-fix", "spec-gap"])
const CHECK_STEPS = new Set(["checks", "test-fix"])

export const fixRecordPath = (worktree: string, e: number) => join(runDir(worktree), `fix-${e}.md`)

// /fix <issue> の開始。エスカレーションしていなければ、何もせずに理由を返す
export function startFix(deps: StepDeps, issue: number): StepResult {
  const id = runIdFor({ kind: "dev", issue })
  const run = deps.store.get(id)
  if (!run) return { kind: "error", message: `issue #${issue} の run はありません。/dev ${issue} で開発を始めてください` }
  if (run.status !== "escalated" || !run.lastEscalation || !run.worktree)
    return { kind: "error", message: `${id} はエスカレーションされていないため、/fix では何もしません（状態: ${run.status}、工程: ${run.step}）。${nextFor(run)}` }

  // テストの変更申請への判断を待っていれば、先に判断を求める（#36）
  const pending = pendingDecision(run)
  if (pending) return pending

  const worktree = run.worktree
  const e = run.lastEscalation.number
  const record = fixRecordPath(worktree, e)
  deps.store.appendEvent(run.id, { type: "fix.started", escalation: e, reason: run.lastEscalation.reason })
  return {
    kind: "need_user",
    message: [
      `${id} はエスカレーションされています（理由: ${run.lastEscalation.reason}、工程: ${run.step}）。報告の要約をユーザーに示し、方針をすり合わせてください。`,
      "",
      "## 報告",
      "",
      reportBody(run.lastEscalation.report),
      "",
      "## 材料（必要に応じて読む）",
      "",
      ...materials(deps, run).map((m) => `- ${m}`),
      "",
      "## 方針の選択肢（question ツールの選択肢にする）",
      "",
      ...options(run).map((o, i) => `${i + 1}. ${o}`),
      "",
      "## 手順",
      "",
      "1. 報告を短く要約して示し、question ツールで上の選択肢から方針を選んでもらう。直すなら、どう直すかも具体的にすり合わせる",
      `2. 決まった方針で、worktree（${worktree}）のコードを直す。checks のコマンドを実行して確かめてよい。テストファイルとハーネスの成果物は編集できない`,
      `3. 修正の記録 ${record} を書く。frontmatter は status: done、見出しは「## 方針」（選んだ方針と理由）と「## 修正」（何をどう直したか。コードを変えていなければ「なし」とその理由）`,
      `4. harness_advance(run: "${id}") を呼ぶ。ハーネスが commit し、checks → review（human モードで 1 周）に進む。「結果: continue」の間は呼び続ける`,
      "- テストのほうが仕様と合っていなければ、テストは変えずに、変更申請を書いてから 3 と 4 に進む（ハーネスが承認を求める）",
      "- 指摘を免除するなら、ユーザーの指示と理由を確かめて harness_waive を呼んでから、3 と 4 に進む",
    ].join("\n"),
  }
}

// エスカレーションした run で harness_advance が呼ばれたとき、修正の記録ができていれば再開する。再開しなければ undefined
export async function resumeFromFix(deps: StepDeps, run: RunState): Promise<StepResult | undefined> {
  const worktree = run.worktree
  const e = run.lastEscalation?.number
  if (!worktree || !e || !isRecordDone(fixRecordPath(worktree, e), SECTIONS)) return undefined

  // commit の前にテストのロックを照合する。変更されていたら元に戻し、再開しない
  const violated = await enforceLock(deps, run)
  if (violated) return { ...violated, message: `${violated.message}\n修正を見直してから、もう一度 harness_advance を呼んでください` }
  const commit = await checkpoint(deps, worktree, `fix: #${run.issue} をエスカレーション ${e} から直す（/fix）`)
  if (typeof commit !== "string") return commit
  deps.store.appendEvent(run.id, { type: "fix.completed", escalation: e, commit })

  // テストの変更申請が書かれていれば、先に判断を求める（#36）。承認されたら test-writer がテストを変えて checks に進む
  const request = findPendingRequest(worktree)
  if (request) {
    const handled = await handleChangeRequest(deps, deps.store.get(run.id) ?? run, request)
    if ("kind" in handled) return handled
  }

  const latest = deps.store.get(run.id) ?? run
  // human モードのまま戻す（review-fix は自動で実行しない）。test-fix の回数と指紋の履歴は数え直す
  deps.store.save({ ...latest, status: "in_progress", step: "checks", testFix: 0, fingerprints: [], rejectedChangeRequest: undefined })
  return { kind: "continue", message: `修正を commit しました（${commit.slice(0, 7)}）。次の工程: checks（その後 review を human モードで 1 周）` }
}

function nextFor(run: RunState): string {
  if (run.status === "done") return run.prUrl ? `PR（${run.prUrl}）はすでにあります。` : ""
  if (run.status === "interrupted") return "中断された run です。"
  return `/dev ${run.issue} で続けられます。`
}

function reportBody(path: string): string {
  if (!existsSync(path)) return `（報告 ${path} がありません）`
  return `報告: ${path}\n\n${readFileSync(path, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()}`
}

function materials(deps: StepDeps, run: RunState): string[] {
  const worktree = run.worktree!
  const dir = runDir(worktree)
  const exists = (p: string) => existsSync(p)
  const latest = (sub: string, pattern: RegExp) => {
    const d = join(dir, sub)
    if (!exists(d)) return undefined
    const files = readdirSync(d).filter((f) => pattern.test(f)).sort((a, b) => parseInt(a.replace(/\D/g, "")) - parseInt(b.replace(/\D/g, "")))
    return files.length ? join(d, files.at(-1)!) : undefined
  }
  const lastChecks = latest("checks", /^run-\d+\.md$/)
  const lastReview = run.reviewRounds ? join(dir, "reviews", `round-${run.reviewRounds}`, "summary.md") : undefined
  return [
    `issue: ${join(dir, "00-issue.md")}（受け入れ基準が仕様の正）`,
    `計画: ${planPath(worktree)}`,
    `差分: git -C ${worktree} diff ${baseBranchOf(deps.config, run)}...HEAD -- . ":(exclude).opencode"`,
    ...(lastChecks ? [`最後の checks の結果（失敗ログ）: ${lastChecks}`] : []),
    ...(exists(testFixDir(worktree)) ? [`test-fix の記録: ${testFixDir(worktree)}`] : []),
    ...(lastReview && exists(lastReview) ? [`最後のレビューの集計（指摘）: ${lastReview}`] : []),
    ...(exists(reviewFixDir(worktree)) ? [`review-fix の記録: ${reviewFixDir(worktree)}`] : []),
    ...(exists(waiversPath(worktree)) ? [`免除リスト: ${waiversPath(worktree)}`] : []),
    `テストの変更申請の置き場所: ${changeRequestDir(worktree)}（test-<番号>.md。frontmatter に status: pending、tests、ac。本文に「## 理由」「## 変更内容」）`,
  ]
}

// エスカレーションの理由と工程に応じた、方針の選択肢
function options(run: RunState): string[] {
  const reason = run.lastEscalation?.reason
  const list = ["直す: 原因と直し方をすり合わせ、harness-fix がコードを直す"]
  if (REVIEW_STEPS.has(run.step)) list.push("指摘を免除して進める: 指摘が受け入れ基準に照らして不要なら、理由を添えて免除する（harness_waive）")
  if (CHECK_STEPS.has(run.step) || reason === "no_progress") list.push("テストの変更を申請する: テストのほうが受け入れ基準と合っていなければ、変更申請を書く")
  if (reason === "budget") list.push("予算を見直して再開する: harness.config.json の budget.maxChildSessionsPerIssue を上げ、コードは変えずに再開する")
  list.push("今は止める: 何もせず、後で /fix をやり直す")
  return list
}
