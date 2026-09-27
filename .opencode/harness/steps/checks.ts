// checks の工程（計画 8.2）。設定の checks（lint・型・ビルド・テスト全体）を順に実行し、結果を成果物に保存する。
// LLM は使わない。1 つが失敗しても残りも実行し、全体の状況を記録する
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Check } from "../config.ts"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import { parseJUnit, type TestCaseResult } from "../testing/junit.ts"
import { runDir } from "./common.ts"
import { errorLines, judge, readBaseline, testId, type Judged } from "./baseline.ts"

export type CheckOutcome = {
  check: Check
  passed: boolean
  timedOut: boolean
  durationMs: number
  output: string
  // 出力全体から取り出した error の行（ベースラインとの比較に使う）
  errorLines: string[]
  tests?: { total: number; failed: TestCaseResult[]; passed: TestCaseResult[] }
  junitMissing?: boolean
}

// ベースラインと照らした判定を加えた結果
type Judgement = CheckOutcome & { judged: Judged }

const OUTPUT_TAIL_LINES = 40

export async function runChecks(deps: StepDeps, run: RunState): Promise<StepResult> {
  const worktree = run.worktree
  if (!worktree) return { kind: "error", message: "worktree が記録されていません。setup からやり直してください" }

  // ベースラインの失敗は除外して判定する（#32）
  const baseline = readBaseline(worktree)
  const outcomes: Judgement[] = []
  for (const check of deps.config.checks) {
    const outcome = await runOne(deps, worktree, check)
    outcomes.push({ ...outcome, judged: judge(outcome, baseline?.checks.find((c) => c.name === check.name)) })
  }
  const excused = outcomes.flatMap((o) => o.judged.excused)
  const resolved = outcomes.flatMap((o) => o.judged.resolved)

  const n = (run.checksRuns ?? 0) + 1
  const passed = outcomes.every((o) => o.judged.passed)
  const dir = join(runDir(worktree), "checks")
  mkdirSync(dir, { recursive: true })
  const recordPath = join(dir, `run-${n}.md`)
  writeFileSync(recordPath, render(n, outcomes, (deps.now?.() ?? new Date()).toISOString()))
  deps.store.appendEvent(run.id, {
    type: "checks.completed",
    run: n,
    passed,
    results: outcomes.map((o) => ({ name: o.check.name, passed: o.judged.passed, timedOut: o.timedOut, durationMs: o.durationMs })),
    excused,
    resolved,
  })

  if (passed) {
    deps.store.save({ ...run, checksRuns: n, step: "review" })
    return { kind: "continue", message: `checks がすべて通りました（${outcomes.map((o) => o.check.name).join("、")}）。記録: ${recordPath}。次の工程: review` }
  }
  // M1 では失敗したら止める。修正のループ（test-fix）は M2 で入れる
  deps.store.save({ ...run, checksRuns: n, status: "escalated" })
  const failed = outcomes.filter((o) => !o.judged.passed)
  return {
    kind: "escalated",
    message: [`checks が失敗しました（checks_failed）。記録: ${recordPath}`, ...failed.map((o) => `- ${o.check.name}: ${summary(o)}`)].join("\n"),
  }
}

export async function runOne(deps: StepDeps, worktree: string, check: Check): Promise<CheckOutcome> {
  const junitPath = check.junit ? join(worktree, check.junit) : undefined
  if (junitPath) rmSync(junitPath, { force: true }) // 前回の結果を今回の結果として読まないように消しておく
  const r = await deps.shell(check.command, { cwd: worktree, timeoutSec: check.timeoutSec })
  const full = [r.stdout, r.stderr].filter(Boolean).join("\n")
  const outcome: CheckOutcome = {
    check,
    passed: r.code === 0 && !r.timedOut,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    output: tail(full),
    errorLines: errorLines(full),
  }
  if (junitPath) {
    if (existsSync(junitPath)) {
      const cases = parseJUnit(readFileSync(junitPath, "utf8"))
      outcome.tests = { total: cases.length, failed: cases.filter((c) => c.status === "failed"), passed: cases.filter((c) => c.status === "passed") }
    } else outcome.junitMissing = true
  }
  return outcome
}

function summary(o: Judgement): string {
  if (o.timedOut) return `失敗（タイムアウト: ${o.check.timeoutSec} 秒）`
  const tests = o.tests ? `（テスト ${o.tests.total} 件、失敗 ${o.tests.failed.length} 件）` : ""
  const excused = o.judged.excused.length ? `（ベースラインの失敗 ${o.judged.excused.length} 件を除外）` : ""
  return `${o.judged.passed ? "成功" : "失敗"}${tests}${excused}`
}

function render(n: number, outcomes: Judgement[], at: string): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
  const excused = outcomes.flatMap((o) => o.judged.excused)
  const resolved = outcomes.flatMap((o) => o.judged.resolved)
  const lines = [
    "---",
    `status: ${outcomes.every((o) => o.judged.passed) ? "passed" : "failed"}`,
    `baseline_excused: ${excused.length}`,
    `baseline_resolved: ${resolved.length}`,
    `run: ${n}`,
    `at: ${at}`,
    "---",
    `# checks の結果（${n} 回目）`,
    "",
    "| チェック | 結果 | 時間 | コマンド |",
    "|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.check.name} | ${summary(o)} | ${(o.durationMs / 1000).toFixed(1)} 秒 | \`${cell(o.check.command)}\` |`),
  ]
  const missing = outcomes.filter((o) => o.junitMissing)
  if (missing.length > 0) lines.push("", ...missing.map((o) => `- ${o.check.name}: JUnit（${o.check.junit}）が出力されていません`))

  if (excused.length > 0)
    lines.push("", "## ベースラインの失敗として除外したもの", "", "変更を加える前から失敗していたため、判定から除外した（00-baseline.md）。", "", ...excused.map((e) => `- ${e}`))
  if (resolved.length > 0) lines.push("", "## ベースラインの失敗が解消したもの", "", ...resolved.map((r) => `- ${r}`))

  const excusedIds = new Set(excused)
  const failedTests = outcomes.flatMap((o) => o.tests?.failed ?? []).filter((t) => !excusedIds.has(testId(t)))
  if (failedTests.length > 0)
    lines.push(
      "",
      "## 失敗したテスト",
      "",
      "| テスト | ファイル | 理由 |",
      "|---|---|---|",
      ...failedTests.map((t) => `| ${cell(t.name)} | ${cell(t.file)} | ${cell(`${t.failureType ?? "?"}: ${(t.message ?? "").split(/\r?\n/)[0]}`)} |`),
    )
  for (const o of outcomes.filter((o) => !o.judged.passed && o.output))
    lines.push("", `## ${o.check.name} の出力（末尾）`, "", "```", o.output, "```")
  lines.push("")
  return lines.join("\n")
}

const tail = (s: string) => s.trim().split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join("\n")
