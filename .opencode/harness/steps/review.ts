// review の工程（計画 8.4）。M1 では spec の観点だけを、judge なしで実行する。
// レビュアーの出力を機械的に読み取り、根拠（AC の ID と「ファイル:行」）のそろった spec_violation だけを blocking として数える。
// blocking があれば review-fix のループに入る（#37）。上限・autoFixBudget・再発（oscillation）・human モードではエスカレーションする。
// spec_gap（仕様の曖昧さ）は、ループの回数に数えずに、先にユーザーに解釈を聞く（#38）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readFrontmatter } from "../artifacts.ts"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { Finding, RunState } from "../state.ts"
import { baseBranchOf, baseChildPermissions, editOnly, readTemplate, runDir } from "./common.ts"
import { escalate, type Escalation } from "./escalation.ts"
import { planPath } from "./plan.ts"
import { reviewFixAttempts } from "./review-fix.ts"
import { decisionsPath, parseOptions, runSpecGap } from "./spec-gap.ts"

const PERSPECTIVE = "spec"
const CATEGORIES = ["spec_violation", "spec_gap", "test_gaming", "safety_critical", "other"] as const
// この観点で blocking にできる分類（spec の観点では仕様違反だけ。test_gaming は test-integrity の観点が見る）
const BLOCKING_CATEGORIES = new Set(["spec_violation"])
const EVIDENCE = /[\w./\\-]+:\d+/
const AC_ID = /\bAC-\d+\b/

// Finding の id はレビュアーが振る周ごとの連番（F-01）。key は周をまたいで同じ指摘を見分ける ID（観点 + AC の ID + ファイル。judge は M3）
export type { Finding }
export type ParsedReview = {
  problems: string[]
  blocking: Finding[]
  // 根拠（曖昧な AC の ID と、2 つ以上の解釈）のそろった spec_gap。ユーザーに聞く
  gaps: { finding: Finding; options: string[] }[]
  downgraded: { finding: Finding; reason: string }[]
  nonBlocking: Finding[]
}

export function parseReview(content: string, perspective = PERSPECTIVE): ParsedReview {
  const result: ParsedReview = { problems: [], blocking: [], gaps: [], downgraded: [], nonBlocking: [] }
  if (readFrontmatter(content).status !== "done") result.problems.push("frontmatter が status: done になっていません")
  if (!/^\|\s*ID\s*\|\s*分類\s*\|/m.test(content)) result.problems.push("指摘の表（| ID | 分類 | blocking | AC | 根拠（ファイル:行） | 内容 |）がありません")

  for (const line of content.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim())
    const id = cells[1]
    if (!id || !/^F-\d+$/.test(id)) continue
    const ac = cells[4] ?? ""
    const evidence = cells[5] ?? ""
    const f: Finding = { id, key: findingKey(perspective, ac, evidence), category: cells[2] ?? "", blocking: cells[3] === "yes", ac, evidence, content: cells[6] ?? "" }
    if (!(CATEGORIES as readonly string[]).includes(f.category)) result.problems.push(`${id} の分類「${f.category}」は決まりにありません（${CATEGORIES.join(" / ")}）`)
    if (cells[3] !== "yes" && cells[3] !== "no") result.problems.push(`${id} の blocking は yes か no で書いてください（「${cells[3]}」）`)
    if (f.category === "spec_gap") {
      const options = parseOptions(f.content)
      if (AC_ID.test(f.ac) && options.length >= 2) result.gaps.push({ finding: f, options })
      else result.downgraded.push({ finding: f, reason: "spec_gap の根拠（曖昧な AC の ID と、「解釈1: … / 解釈2: …」の 2 つ以上の解釈）が足りないため、other として扱います" })
    } else if (!f.blocking) result.nonBlocking.push(f)
    else if (!BLOCKING_CATEGORIES.has(f.category)) result.downgraded.push({ finding: f, reason: `分類 ${f.category} はこの観点では blocking にできません` })
    else if (!AC_ID.test(f.ac)) result.downgraded.push({ finding: f, reason: "対応する AC の ID がありません" })
    else if (!EVIDENCE.test(f.evidence)) result.downgraded.push({ finding: f, reason: "根拠（ファイル:行）がありません" })
    else result.blocking.push(f)
  }
  return result
}

// 指摘の ID（簡易版）: 観点 + 最初の AC の ID + 根拠のファイル（行番号は、修正で行がずれても同じ指摘とみなすため除く）
export function findingKey(perspective: string, ac: string, evidence: string): string {
  const file = evidence.match(EVIDENCE)?.[0]?.replace(/:\d+$/, "").replace(/\\/g, "/").replace(/^\.\//, "") ?? "-"
  return `${perspective}:${ac.match(AC_ID)?.[0] ?? "-"}:${file}`
}

const roundDir = (worktree: string, round: number) => join(runDir(worktree), "reviews", `round-${round}`)
const summaryPathOf = (worktree: string, round: number) => join(roundDir(worktree, round), "summary.md")

export async function runReview(deps: StepDeps, run: RunState): Promise<StepResult> {
  const worktree = run.worktree
  if (!worktree) return { kind: "error", message: "worktree が記録されていません。setup からやり直してください" }
  const perspective = deps.config.review.perspectives.find((p) => p.name === PERSPECTIVE && p.session === "separate")
  const modelKey = perspective?.model ?? "dev.review.spec"
  const model = deps.config.models[modelKey]?.[0]
  if (!model) return { kind: "error", message: `harness.config.json の models に「${modelKey}」がありません（spec の観点のレビューに使う）` }

  const round = (run.reviewRounds ?? 0) + 1
  const dir = roundDir(worktree, round)
  mkdirSync(dir, { recursive: true })
  const output = join(dir, `${PERSPECTIVE}.md`)

  // レビューの入力: ベースからの差分（ハーネス自身の .opencode/ は除く）。
  // 2 周目以降は、前回レビューした commit からの差分と、前回の blocking 指摘だけを見させる（計画 8.4）
  const previous = round > 1 && run.reviewedCommit ? { commit: run.reviewedCommit, summary: summaryPathOf(worktree, round - 1) } : undefined
  const diffPath = join(dir, "input.diff")
  const range = previous ? `${previous.commit}..HEAD` : `${baseBranchOf(deps.config, run)}...HEAD`
  const diff = await deps.exec("git", ["diff", range, "--", ".", ":(exclude).opencode"], { cwd: worktree })
  if (diff.code !== 0) return { kind: "error", message: `差分を取得できませんでした: ${diff.stderr.trim()}` }
  writeFileSync(diffPath, diff.stdout)
  const head = await deps.exec("git", ["rev-parse", "HEAD"], { cwd: worktree })
  if (head.code !== 0) return { kind: "error", message: `HEAD の commit を取得できませんでした: ${head.stderr.trim()}` }

  const common = {
    runId: run.id,
    directory: worktree,
    title: `${run.id}: review（${PERSPECTIVE}）`,
    agent: "reviewer",
    model,
    permission: [...baseChildPermissions(worktree), ...editOnly(`${PERSPECTIVE}.md`)],
  }
  const first = await deps.child({ ...common, prompt: reviewPrompt(worktree, diffPath, output, previous?.summary) })
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

  // 回答済みの spec_gap は、もう一度は聞かない
  const latest = deps.store.get(run.id) ?? run
  const answered = new Set(latest.answeredGaps ?? [])
  parsed = {
    ...parsed,
    gaps: parsed.gaps.filter((g) => !answered.has(g.finding.key)),
    downgraded: [...parsed.downgraded, ...parsed.gaps.filter((g) => answered.has(g.finding.key)).map((g) => ({ finding: g.finding, reason: `回答済みの spec_gap です（${decisionsPath(worktree)}）` }))],
  }
  const summaryPath = summaryPathOf(worktree, round)
  writeFileSync(summaryPath, renderSummary(round, parsed))
  deps.store.appendEvent(run.id, { type: "review.completed", round, blocking: parsed.blocking.length, gaps: parsed.gaps.length, downgraded: parsed.downgraded.length, nonBlocking: parsed.nonBlocking.length })

  // 一度解消した指摘（前の周に出て、直前の周には出なかった指摘）が再び出たら、揺り戻し
  const history = latest.findingRounds ?? {}
  const recurred = parsed.blocking.filter((f) => history[f.key]?.length && !history[f.key]!.includes(round - 1))
  const findingRounds = { ...history }
  for (const f of parsed.blocking) findingRounds[f.key] = [...new Set([...(findingRounds[f.key] ?? []), round])]
  const reviewed = { ...latest, reviewRounds: round, reviewedCommit: head.stdout.trim(), findingRounds }

  // spec_gap があれば、review-fix より先にユーザーに聞く。ループの回数は増やさない
  if (parsed.gaps.length > 0) {
    const pendingSpecGaps = parsed.gaps.map(({ finding: f, options }) => ({ id: f.id, key: f.key, ac: f.ac, content: f.content, options, round }))
    const waiting = deps.store.save({ ...reviewed, step: "spec-gap", pendingSpecGaps, specGapFollowUp: { blocking: parsed.blocking, recurred, summary: summaryPath } })
    deps.store.appendEvent(run.id, { type: "spec-gap.asked", round, gaps: pendingSpecGaps.map((g) => g.key) })
    return runSpecGap(deps, waiting)
  }
  if (parsed.blocking.length === 0) {
    deps.store.save({ ...reviewed, step: "pr" })
    return { kind: "continue", message: `review が完了しました（blocking 0 件、参考 ${parsed.nonBlocking.length} 件）。記録: ${summaryPath}。次の工程: pr` }
  }
  deps.store.save(reviewed)
  return afterReviewBlocking(deps, reviewed, parsed.blocking, recurred, summaryPath)
}

// blocking の指摘があったときに、review-fix に進むか、エスカレーションするかを決める
export async function afterReviewBlocking(deps: StepDeps, run: RunState, blocking: Finding[], recurred: Finding[], summaryPath: string): Promise<StepResult> {
  const loops = deps.config.loops
  const reviewFix = run.reviewFix ?? 0
  const used = run.autoFixUsed ?? 0
  const worktree = run.worktree ?? ""
  const rounds = run.reviewRounds ?? 1
  const base = {
    history: Array.from({ length: rounds }, (_, i) => `review ${i + 1} 周目: 記録 ${summaryPathOf(worktree, i + 1)}`),
    attempts: reviewFixAttempts(worktree),
    open: blocking.map((f) => describe(f).replace(/^- /, "")),
  }
  const stop = async (e: Escalation) => {
    const escalated = await escalate(deps, run, e)
    return { ...escalated, message: [escalated.message, ...blocking.map(describe)].join("\n") }
  }

  if (recurred.length > 0)
    return stop({ ...base, reason: "oscillation", summary: `一度解消した blocking の指摘が、review ${rounds} 周目で再び出ました（${recurred.map((f) => f.key).join("、")}）。` })
  if (run.mode === "human")
    return stop({ ...base, reason: "loop_exhausted", summary: `review で blocking の指摘が ${blocking.length} 件ありました。human モードのため、review-fix は自動で実行しません。` })
  if (reviewFix >= loops.reviewFix)
    return stop({ ...base, reason: "loop_exhausted", summary: `review-fix を ${reviewFix} 回（上限 loops.reviewFix）繰り返しても、blocking の指摘が ${blocking.length} 件残っています。` })
  if (used >= loops.autoFixBudget)
    return stop({ ...base, reason: "loop_exhausted", summary: `自動の修正（test-fix と review-fix の合計）が上限 autoFixBudget（${loops.autoFixBudget} 回）に達しました。blocking の指摘が ${blocking.length} 件残っています。` })

  // 回数は工程に入る前に加算して保存する（強制終了で二重に数えない）
  deps.store.save({ ...run, step: "review-fix", reviewFix: reviewFix + 1, autoFixUsed: used + 1 })
  deps.store.appendEvent(run.id, { type: "review-fix.started", k: reviewFix + 1, findings: blocking.map((f) => f.key) })
  return { kind: "continue", message: [`review で blocking の指摘が ${blocking.length} 件ありました（記録: ${summaryPath}）。review-fix の ${reviewFix + 1} 回目に進みます`, ...blocking.map(describe)].join("\n") }
}

const describe = (f: Finding) => `- ${f.id}（${f.category}、${f.ac}、${f.evidence}、ID: ${f.key}）: ${f.content}`

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
    "## spec_gap（ループに数えず、ユーザーに解釈を聞く）",
    ...(parsed.gaps.length ? parsed.gaps.map((g) => `${describe(g.finding)}`) : ["なし"]),
    "",
    "## 根拠が足りないため数えなかった指摘",
    ...(parsed.downgraded.length ? parsed.downgraded.map((d) => `${describe(d.finding)} — ${d.reason}`) : ["なし"]),
    "",
    "## 参考（blocking ではない指摘。PR 本文に載せる）",
    ...(parsed.nonBlocking.length ? parsed.nonBlocking.map(describe) : ["なし"]),
    "",
  ].join("\n")
}

function reviewPrompt(worktree: string, diffPath: string, output: string, previousSummary?: string): string {
  return [
    `次の実装の差分を、「${PERSPECTIVE}」の観点からレビューしてください。`,
    ...(previousSummary
      ? [
          "",
          "これは 2 周目以降のレビューです。見るのは次の 2 つだけにしてください。",
          `1. 前回の blocking の指摘（${previousSummary} の「blocking」の欄）が解消したか。解消していなければ、同じ AC の ID と根拠のファイルで、もう一度 blocking として書く`,
          "2. 前回のレビューからの差分（下の「差分」）が、新しく仕様違反を持ち込んでいないか",
          "前回の差分にあった、ほかの箇所は見直さない。",
        ]
      : []),
    "",
    `- 差分: ${diffPath}${previousSummary ? "（前回のレビューからの差分）" : ""}`,
    `- issue: ${join(runDir(worktree), "00-issue.md")}`,
    `- 計画: ${planPath(worktree)}`,
    ...(existsSync(decisionsPath(worktree)) ? [`- 仕様の確認の記録: ${decisionsPath(worktree)}（ユーザーが決めた解釈。受け入れ基準と合わせて仕様の正とし、実装がこの解釈に合っているかも確かめる。回答済みの点を spec_gap として再び挙げない）`] : []),
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
