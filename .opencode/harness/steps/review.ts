// review の工程（計画 8.4）。M1 では spec の観点だけを、judge なしで実行する。
// レビュアーの出力を機械的に読み取り、根拠（AC の ID と「ファイル:行」）のそろった spec_violation だけを blocking として数える
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readFrontmatter } from "../artifacts.ts"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import { baseBranchOf, baseChildPermissions, editOnly, readTemplate, runDir } from "./common.ts"
import { escalate } from "./escalation.ts"
import { planPath } from "./plan.ts"

const PERSPECTIVE = "spec"
const CATEGORIES = ["spec_violation", "spec_gap", "test_gaming", "safety_critical", "other"] as const
// この観点で blocking にできる分類（spec の観点では仕様違反だけ。test_gaming は test-integrity の観点が見る）
const BLOCKING_CATEGORIES = new Set(["spec_violation"])
const EVIDENCE = /[\w./\\-]+:\d+/
const AC_ID = /\bAC-\d+\b/

export type Finding = { id: string; category: string; blocking: boolean; ac: string; evidence: string; content: string }
export type ParsedReview = {
  problems: string[]
  blocking: Finding[]
  downgraded: { finding: Finding; reason: string }[]
  nonBlocking: Finding[]
}

export function parseReview(content: string): ParsedReview {
  const result: ParsedReview = { problems: [], blocking: [], downgraded: [], nonBlocking: [] }
  if (readFrontmatter(content).status !== "done") result.problems.push("frontmatter が status: done になっていません")
  if (!/^\|\s*ID\s*\|\s*分類\s*\|/m.test(content)) result.problems.push("指摘の表（| ID | 分類 | blocking | AC | 根拠（ファイル:行） | 内容 |）がありません")

  for (const line of content.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim())
    const id = cells[1]
    if (!id || !/^F-\d+$/.test(id)) continue
    const f: Finding = { id, category: cells[2] ?? "", blocking: cells[3] === "yes", ac: cells[4] ?? "", evidence: cells[5] ?? "", content: cells[6] ?? "" }
    if (!(CATEGORIES as readonly string[]).includes(f.category)) result.problems.push(`${id} の分類「${f.category}」は決まりにありません（${CATEGORIES.join(" / ")}）`)
    if (cells[3] !== "yes" && cells[3] !== "no") result.problems.push(`${id} の blocking は yes か no で書いてください（「${cells[3]}」）`)
    if (!f.blocking) result.nonBlocking.push(f)
    else if (!BLOCKING_CATEGORIES.has(f.category)) result.downgraded.push({ finding: f, reason: `分類 ${f.category} はこの観点では blocking にできません` })
    else if (!AC_ID.test(f.ac)) result.downgraded.push({ finding: f, reason: "対応する AC の ID がありません" })
    else if (!EVIDENCE.test(f.evidence)) result.downgraded.push({ finding: f, reason: "根拠（ファイル:行）がありません" })
    else result.blocking.push(f)
  }
  return result
}

export async function runReview(deps: StepDeps, run: RunState): Promise<StepResult> {
  const worktree = run.worktree
  if (!worktree) return { kind: "error", message: "worktree が記録されていません。setup からやり直してください" }
  const perspective = deps.config.review.perspectives.find((p) => p.name === PERSPECTIVE && p.session === "separate")
  const modelKey = perspective?.model ?? "dev.review.spec"
  const model = deps.config.models[modelKey]?.[0]
  if (!model) return { kind: "error", message: `harness.config.json の models に「${modelKey}」がありません（spec の観点のレビューに使う）` }

  const round = (run.reviewRounds ?? 0) + 1
  const dir = join(runDir(worktree), "reviews", `round-${round}`)
  mkdirSync(dir, { recursive: true })
  const output = join(dir, `${PERSPECTIVE}.md`)

  // レビューの入力: ベースからの差分（ハーネス自身の .opencode/ は除く）
  const diffPath = join(dir, "input.diff")
  const diff = await deps.exec("git", ["diff", `${baseBranchOf(deps.config, run)}...HEAD`, "--", ".", ":(exclude).opencode"], { cwd: worktree })
  if (diff.code !== 0) return { kind: "error", message: `差分を取得できませんでした: ${diff.stderr.trim()}` }
  writeFileSync(diffPath, diff.stdout)

  const common = {
    runId: run.id,
    directory: worktree,
    title: `${run.id}: review（${PERSPECTIVE}）`,
    agent: "reviewer",
    model,
    permission: [...baseChildPermissions(worktree), ...editOnly(`${PERSPECTIVE}.md`)],
  }
  const first = await deps.child({ ...common, prompt: reviewPrompt(worktree, diffPath, output) })
  if (first.status !== "completed") return childFailed(first)
  deps.store.save({ ...run, sessions: { ...run.sessions, [`review-${round}-${PERSPECTIVE}`]: first.sessionID } })

  // 不完全な出力（完了マーカー・表の欠落、決まりに沿わない値）は、同じセッションに 1 回だけ直させる
  let parsed = parseReview(readIfExists(output))
  if (parsed.problems.length > 0) {
    const retry = await deps.child({ ...common, sessionID: first.sessionID, prompt: fixPrompt(output, parsed.problems) })
    if (retry.status !== "completed") return childFailed(retry)
    parsed = parseReview(readIfExists(output))
    if (parsed.problems.length > 0)
      return { kind: "error", message: [`レビューの出力が不完全です（${output}）:`, ...parsed.problems.map((p) => `- ${p}`)].join("\n") }
  }

  const summaryPath = join(dir, "summary.md")
  writeFileSync(summaryPath, renderSummary(round, parsed))
  const latest = deps.store.get(run.id) ?? run
  deps.store.appendEvent(run.id, { type: "review.completed", round, blocking: parsed.blocking.length, downgraded: parsed.downgraded.length, nonBlocking: parsed.nonBlocking.length })

  if (parsed.blocking.length === 0) {
    deps.store.save({ ...latest, reviewRounds: round, step: "pr" })
    return { kind: "continue", message: `review が完了しました（blocking 0 件、参考 ${parsed.nonBlocking.length} 件）。記録: ${summaryPath}。次の工程: pr` }
  }
  // 修正のループ（review-fix）は #37 で入れる。それまでは、blocking があればエスカレーションする（上限 0 回のループとして扱う）
  const reviewed = { ...latest, reviewRounds: round }
  deps.store.save(reviewed)
  const escalated = await escalate(deps, reviewed, {
    reason: "loop_exhausted",
    summary: `review で blocking の指摘が ${parsed.blocking.length} 件ありました。`,
    history: [`review ${round} 周目: 記録 ${summaryPath}`],
    open: parsed.blocking.map((f) => describe(f).replace(/^- /, "")),
  })
  return { ...escalated, message: [escalated.message, ...parsed.blocking.map(describe)].join("\n") }
}

const describe = (f: Finding) => `- ${f.id}（${f.category}、${f.ac}、${f.evidence}）: ${f.content}`

function renderSummary(round: number, parsed: ParsedReview): string {
  return [
    "---",
    "status: done",
    `round: ${round}`,
    `blocking_count: ${parsed.blocking.length}`,
    "---",
    `# レビューの集計（${round} 回目）`,
    "",
    "## blocking（ループの対象）",
    ...(parsed.blocking.length ? parsed.blocking.map(describe) : ["なし"]),
    "",
    "## 根拠が足りないため数えなかった指摘",
    ...(parsed.downgraded.length ? parsed.downgraded.map((d) => `${describe(d.finding)} — ${d.reason}`) : ["なし"]),
    "",
    "## 参考（blocking ではない指摘。PR 本文に載せる）",
    ...(parsed.nonBlocking.length ? parsed.nonBlocking.map(describe) : ["なし"]),
    "",
  ].join("\n")
}

function reviewPrompt(worktree: string, diffPath: string, output: string): string {
  return [
    `次の実装の差分を、「${PERSPECTIVE}」の観点からレビューしてください。`,
    "",
    `- 差分: ${diffPath}`,
    `- issue: ${join(runDir(worktree), "00-issue.md")}`,
    `- 計画: ${planPath(worktree)}`,
    "- 必要に応じて、差分に出てくるファイルの全体を読んでよい",
    `- 出力先: ${output}（このファイル以外は編集できない）。エージェントの説明にある形式で書き、書き終えたら status: done にする`,
    "",
    readTemplate(`review/perspectives/${PERSPECTIVE}.md`).trim(),
  ].join("\n")
}

function fixPrompt(output: string, problems: string[]): string {
  return [`レビュー（${output}）の形式に次の不足があります。直してください。`, ...problems.map((p) => `- ${p}`), "", "直し終えたら frontmatter を status: done にすること。"].join("\n")
}

function childFailed(result: { status: "error" | "aborted"; error?: string }): StepResult {
  if (result.status === "aborted") return { kind: "error", message: "review の子セッションが中断されました。harness_advance で再開できます" }
  return { kind: "error", message: `review の子セッションがエラーで終わりました: ${result.error}` }
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}
