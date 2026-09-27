// ベースライン（計画 8.2 setup ④、#32）。変更を加える前の worktree で checks を実行し、もともとの失敗を記録する。
// 以降の checks の判定では、ベースラインの失敗を除外する（issue と関係のない既存の失敗で、ループやエスカレーションが起きないように）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StepDeps } from "../machine/dev.ts"
import type { TestCaseResult } from "../testing/junit.ts"
import { runOne, type CheckOutcome } from "./checks.ts"
import { runDir } from "./common.ts"

export type BaselineCheck = {
  name: string
  passed: boolean
  timedOut: boolean
  // JUnit のあるチェック: もともと失敗しているテストの ID
  failedTests: string[]
  // JUnit のないチェック: もともと出ているエラーの行（数字を伏せたもの）
  errorLines: string[]
}
export type Baseline = { checks: BaselineCheck[] }

// 判定の結果。excused: ベースラインの失敗として除外したもの、resolved: ベースラインの失敗のうち通るようになったもの
export type Judged = { passed: boolean; excused: string[]; resolved: string[] }

const JSON_FILE = "baseline.json"
const MD_FILE = "00-baseline.md"

export const testId = (t: Pick<TestCaseResult, "file" | "name">) => `${t.file} > ${t.name}`

// 出力から error を含む行を取り出し、行番号・列番号などの数字を伏せる（コードの変更で行がずれても同じエラーとみなすため）
export function errorLines(output: string): string[] {
  const lines = output
    .split(/\r?\n/)
    .filter((l) => /\berror\b/i.test(l))
    .map((l) => l.trim().replace(/\d+/g, "#"))
  return [...new Set(lines)]
}

export function readBaseline(worktree: string): Baseline | undefined {
  const path = join(runDir(worktree), JSON_FILE)
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Baseline) : undefined
}

export async function recordBaseline(deps: StepDeps, worktree: string): Promise<Baseline> {
  const outcomes: CheckOutcome[] = []
  for (const check of deps.config.checks) outcomes.push(await runOne(deps, worktree, check))
  const baseline: Baseline = {
    checks: outcomes.map((o) => ({
      name: o.check.name,
      passed: o.passed,
      timedOut: o.timedOut,
      failedTests: (o.tests?.failed ?? []).map(testId),
      errorLines: o.passed || o.tests ? [] : o.errorLines,
    })),
  }
  const dir = runDir(worktree)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, JSON_FILE), JSON.stringify(baseline, null, 2) + "\n")
  writeFileSync(join(dir, MD_FILE), render(baseline, (deps.now?.() ?? new Date()).toISOString()))
  return baseline
}

// 1 つのチェックの結果を、ベースラインと照らして判定する
export function judge(outcome: CheckOutcome, base: BaselineCheck | undefined): Judged {
  const failedIds = (outcome.tests?.failed ?? []).map(testId)
  const passedIds = new Set((outcome.tests?.passed ?? []).map(testId))
  const resolved = (base?.failedTests ?? []).filter((id) => passedIds.has(id))
  if (outcome.passed) return { passed: true, excused: [], resolved }
  const fail: Judged = { passed: false, excused: [], resolved }
  // タイムアウトや、ベースラインでは通っていたチェックは、除外しない
  if (outcome.timedOut || !base || base.passed) return fail

  if (outcome.tests) {
    if (outcome.junitMissing || failedIds.length === 0) return fail
    const known = new Set(base.failedTests)
    return failedIds.every((id) => known.has(id)) ? { passed: true, excused: failedIds, resolved } : fail
  }
  // JUnit のないチェック: 比べる手がかり（error の行）がなければ除外しない
  const current = outcome.errorLines
  if (base.errorLines.length === 0 || current.length === 0) return fail
  const known = new Set(base.errorLines)
  return current.every((l) => known.has(l)) ? { passed: true, excused: current, resolved } : fail
}

function render(baseline: Baseline, at: string): string {
  const failures = baseline.checks.reduce((n, c) => n + (c.passed ? 0 : Math.max(c.failedTests.length, 1)), 0)
  const lines = [
    "---",
    `failures: ${failures}`,
    `at: ${at}`,
    "---",
    "# ベースライン（変更を加える前の checks の結果）",
    "",
    "ここにある失敗は、この issue の変更とは関係なく、もともと起きている。以降の checks の判定では除外する。",
    "",
    "| チェック | 結果 |",
    "|---|---|",
    ...baseline.checks.map((c) => `| ${c.name} | ${c.passed ? "成功" : c.timedOut ? "失敗（タイムアウト。除外の対象にしない）" : "失敗"} |`),
  ]
  for (const c of baseline.checks.filter((c) => !c.passed)) {
    if (c.failedTests.length) lines.push("", `## ${c.name}: もともと失敗しているテスト`, "", ...c.failedTests.map((t) => `- ${t}`))
    else if (c.errorLines.length) lines.push("", `## ${c.name}: もともと出ているエラー（数字は # に置き換え）`, "", ...c.errorLines.map((l) => `- \`${l}\``))
    else if (!c.timedOut) lines.push("", `## ${c.name}`, "", "- 失敗しているが、比べる手がかり（テストの結果や error の行）がないため、除外の対象にしない")
  }
  lines.push("")
  return lines.join("\n")
}
