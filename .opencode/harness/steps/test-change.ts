// テストの変更申請（計画 8.2「テストの変更申請」、#36）
// テストのほうが仕様と合っていないと test-fixer が判断したら、change-requests/test-<c>.md に申請を書かせる。
// ハーネスはエスカレーションして人の判断を待ち、承認されたら test-writer がテストを変えてロックを更新する。
// 実装役（implementer / test-fixer / review-fixer）がテストを変えることはない
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readFrontmatter, setFrontmatter } from "../artifacts.ts"
import type { RecordInput, StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import type { PermissionRule } from "../session.ts"
import { parseJUnit } from "../testing/junit.ts"
import { createLock, globToRegExp } from "../testing/lock.ts"
import { baseChildPermissions, runDir } from "./common.ts"
import { escalate } from "./escalation.ts"
import { checkpoint } from "./red.ts"

const MODEL_KEYS = ["dev.test-writer"]

export const changeRequestDir = (worktree: string) => join(runDir(worktree), "change-requests")

// まだ判断されていない申請（frontmatter の status が pending のもの）
export function findPendingRequest(worktree: string): string | undefined {
  const dir = changeRequestDir(worktree)
  if (!existsSync(dir)) return undefined
  return readdirSync(dir)
    .filter((f) => /^test-\d+\.md$/.test(f))
    .sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)))
    .map((f) => join(dir, f))
    .find((p) => (readFrontmatter(readFileSync(p, "utf8")).status ?? "pending") === "pending")
}

const markRequest = (path: string, status: string) => writeFileSync(path, setFrontmatter(readFileSync(path, "utf8"), "status", status))

// test-fix が申請を書いて終えたときの扱い。申請として扱わなければ undefined を返し、呼び出し側は通常の test-fix として続ける
export async function handleChangeRequest(deps: StepDeps, run: RunState, path: string): Promise<StepResult | { invalid: string }> {
  const text = readFileSync(path, "utf8")
  const fm = readFrontmatter(text)
  const ac = fm.ac?.match(/AC-\d+/g)
  if (!ac) {
    markRequest(path, "invalid")
    deps.store.appendEvent(run.id, { type: "test-change.invalid", request: path })
    return { invalid: `テストの変更申請（${path}）に根拠の AC（frontmatter の ac）がないため、申請として扱いませんでした` }
  }
  const latest = { ...run, pendingChangeRequest: path }
  deps.store.save(latest)
  const escalated = await escalate(deps, latest, {
    reason: "test_change_request",
    summary: `test-fixer が、テストのほうが仕様と合っていないとして、テストの変更を申請しました（対象: ${fm.tests ?? "不明"}、根拠: ${ac.join("、")}）。`,
    history: [`申請: ${path}`],
    open: [`申請を承認してテストを変えるか、却下して実装を直させるか`],
  })
  return { kind: "need_user", message: [escalated.message, "", requestSummary(path), "", decisionGuide(path)].join("\n") }
}

// 申請の中身（司令塔がユーザーに示す）
function requestSummary(path: string): string {
  const text = readFileSync(path, "utf8")
  const fm = readFrontmatter(text)
  const body = text.replace(/^---[\s\S]*?\n---\n?/, "").trim()
  return [`テストの変更申請: ${path}`, `- 対象のテスト: ${fm.tests ?? "不明"}`, `- 根拠: ${fm.ac ?? "なし"}`, "", body].join("\n")
}

export function decisionGuide(path: string): string {
  return [
    `手順: 申請（${path}）の要約をユーザーに示し、question ツールで「承認（テストを変える）」「却下（実装を直させる）」から選んでもらい、`,
    `harness_record（gate: "test_change"、decision: approved / rejected）で記録してください。却下のときは、理由を feedback に入れてください。`,
  ].join("\n")
}

// エスカレーション中でも、申請の判断を待っていれば、/fix ではなく判断を求める
export function pendingDecision(run: RunState): StepResult | undefined {
  if (!run.pendingChangeRequest) return undefined
  return { kind: "need_user", message: [`${run.id} はテストの変更申請への判断を待っています。`, "", requestSummary(run.pendingChangeRequest), "", decisionGuide(run.pendingChangeRequest)].join("\n") }
}

export function recordTestChange(deps: StepDeps, run: RunState, input: Extract<RecordInput, { gate: "test_change" }>): StepResult {
  const path = run.pendingChangeRequest
  if (!path) return { kind: "error", message: `${run.id} はテストの変更申請への判断を待っていません` }
  deps.store.appendEvent(run.id, { type: "gate.recorded", gate: "test_change", decision: input.decision, request: path })

  if (input.decision === "approved") {
    markRequest(path, "approved")
    deps.store.save({ ...run, status: "in_progress", step: "test-change" })
    return { kind: "continue", message: "テストの変更申請を承認しました。harness_advance で、test-writer がテストを変えます" }
  }
  const feedback = input.feedback?.trim()
  if (!feedback) return { kind: "error", message: "却下の理由（feedback）が空です。ユーザーに理由を聞いてください" }
  writeFileSync(path, setFrontmatter(readFileSync(path, "utf8"), "status", "rejected") + `\n## 却下の理由\n${feedback}\n`)
  // 却下したら、理由を添えて test-fix に戻る。新しい 1 回として数える
  deps.store.save({
    ...run,
    status: "in_progress",
    step: "test-fix",
    pendingChangeRequest: undefined,
    rejectedChangeRequest: path,
    testFix: (run.testFix ?? 0) + 1,
    autoFixUsed: (run.autoFixUsed ?? 0) + 1,
  })
  return { kind: "continue", message: "テストの変更申請を却下しました。harness_advance で、test-fixer が却下の理由を踏まえて実装を直します" }
}

// 承認された申請どおりに、test-writer がテストを変える
export async function runTestChange(deps: StepDeps, run: RunState): Promise<StepResult> {
  const worktree = run.worktree
  const path = run.pendingChangeRequest
  if (!worktree || !path) return { kind: "error", message: "承認されたテストの変更申請がありません" }
  const model = MODEL_KEYS.map((k) => deps.config.models[k]?.[0]).find(Boolean) ?? deps.config.models["dev.implementer"]?.[0]
  if (!model) return { kind: "error", message: "harness.config.json の models に「dev.test-writer」がありません" }

  const key = `test-change-${path.match(/test-(\d+)\.md$/)?.[1] ?? "1"}`
  const resuming = run.sessions?.[key]
  const result = await deps.child({
    runId: run.id,
    directory: worktree,
    title: `${run.id}: test-change`,
    agent: "test-writer",
    model,
    permission: writerPermissions(worktree, deps),
    sessionID: resuming,
    onSession: (id) => deps.store.save({ ...(deps.store.get(run.id) ?? run), sessions: { ...run.sessions, [key]: id } }),
    prompt: resuming ? `中断されたので、${path} と作業ツリーの状態を確認して、続きを進めてください。` : changePrompt(path),
  })
  if (result.status === "aborted") return { kind: "error", message: "test-change の子セッションが中断されました。harness_advance で続きから再開できます" }
  if (result.status === "error") return { kind: "error", message: `test-change の子セッションがエラーで終わりました: ${result.error}` }

  // テストのファイルだけが変わったか
  const status = await deps.exec("git", ["status", "--porcelain", "--", ".", ":(exclude).harness", ":(exclude).opencode"], { cwd: worktree })
  const changed = status.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim().replace(/^"|"$/g, "").replace(/\\/g, "/"))
  const patterns = deps.config.tests.globs.map(globToRegExp)
  // テストの実行で出力される JUnit のファイルは、変更に数えない
  const outputs = new Set(deps.config.checks.flatMap((c) => (c.junit ? [c.junit.replace(/\\/g, "/")] : [])))
  const others = changed.filter((f) => !patterns.some((p) => p.test(f)) && !outputs.has(f))
  if (others.length > 0) return { kind: "error", message: [`test-change でテスト以外のファイルが変わっています（commit していません）:`, ...others.map((f) => `- ${f}`)].join("\n") }

  // 変えたテストが読み込めるか（import エラーや構文エラーがないか）
  const testCheck = deps.config.checks.find((c) => c.junit)
  if (testCheck?.junit) {
    await deps.shell(testCheck.command, { cwd: worktree, timeoutSec: testCheck.timeoutSec })
    const junitPath = join(worktree, testCheck.junit)
    const broken = existsSync(junitPath) ? parseJUnit(readFileSync(junitPath, "utf8")).filter((c) => c.loadError) : []
    if (!existsSync(junitPath) || broken.length > 0)
      return { kind: "error", message: [`変えたテストを読み込めません（${testCheck.name}）:`, ...broken.map((c) => `- ${c.file}: ${c.message ?? ""}`)].join("\n") }
  }

  const commit = await checkpoint(deps, worktree, `test: #${run.issue} のテストを変更（テストの変更申請 ${path.match(/test-\d+/)?.[0]}）`)
  if (typeof commit !== "string") return commit
  const lock = createLock(worktree, deps.config.tests.globs, commit)
  deps.store.save({ ...(deps.store.get(run.id) ?? run), step: "checks", pendingChangeRequest: undefined, redCommit: commit })
  deps.store.appendEvent(run.id, { type: "lock.updated", commit, files: Object.keys(lock.files).length, request: path })
  return { kind: "continue", message: `申請どおりにテストを変え、ロックを更新しました（commit ${commit.slice(0, 7)}）。次の工程: checks` }
}

function writerPermissions(worktree: string, deps: StepDeps): PermissionRule[] {
  const prefixes = [...new Set(deps.config.checks.map((c) => c.command.trim().split(/\s+/).slice(0, 2).join(" ")))]
  return [
    ...baseChildPermissions(worktree),
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*.harness*", action: "deny" },
    ...prefixes.map((p) => ({ permission: "bash", pattern: `${p}*`, action: "allow" as const })),
  ]
}

function changePrompt(path: string): string {
  return [
    `ユーザーが承認したテストの変更申請（${path}）のとおりに、テストを変えてください。`,
    "",
    "- 変えるのは申請に書かれたテストだけ。テスト以外のファイル（実装など）は変えない",
    "- 申請の根拠の AC に合う期待値にする",
    "- テストを実行して、読み込めること（import エラーや構文エラーがないこと）を確かめてから終える",
  ].join("\n")
}
