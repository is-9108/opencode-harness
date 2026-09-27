// red の工程と redVerify（計画 8.2）
// test-writer に計画どおりのテストを書かせ、ハーネスがテストを実行して「新しいテストがすべて正しい理由で失敗しているか」を
// 機械的に確かめる。合格したらチェックポイントとして commit し、green に進む
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import type { PermissionRule } from "../session.ts"
import { parseJUnit, type TestCaseResult } from "../testing/junit.ts"
import { createLock } from "../testing/lock.ts"
import { baseChildPermissions, runDir } from "./common.ts"
import { parsePlan, planPath, type TestCase } from "./plan.ts"

const MODEL_KEY = "dev.test-writer"
// 最初の依頼に加えて、差し戻しは 2 回まで（計画 8.2）
const MAX_RETURNS = 2
const TC_ID = /\bTC-\d+\b/g
// 正しい Red とみなす失敗: アサーション、またはスタブの「未実装」の例外
const NOT_IMPLEMENTED = /not implemented|notimplemented|未実装/i

export type RedVerdict = { ok: boolean; problems: string[]; rows: { id: string; result: string }[] }

export function evaluateRed(testCases: TestCase[], results: TestCaseResult[]): RedVerdict {
  const problems: string[] = []
  const rows: RedVerdict["rows"] = []
  const planned = new Set(testCases.map((t) => t.id))
  const idsOf = (r: TestCaseResult): string[] => Array.from(r.name.matchAll(TC_ID), (m) => m[0])

  for (const r of results.filter((r) => r.loadError))
    problems.push(`テストファイル ${r.file} を読み込めません（import エラー・構文エラーなど）: ${firstLine(r.message)}`)

  for (const tc of testCases) {
    const matched = results.filter((r) => !r.loadError && idsOf(r).includes(tc.id))
    if (matched.length === 0) {
      problems.push(`${tc.id} のテストが見つかりません（テスト名に「[${tc.id}]」を含めてください）`)
      rows.push({ id: tc.id, result: "見つからない" })
      continue
    }
    for (const r of matched) {
      if (r.status === "passed") {
        problems.push(`${tc.id}「${r.name}」が最初から通っています。スタブにロジックが書かれている可能性があります`)
        rows.push({ id: tc.id, result: "通っている" })
      } else if (r.status === "skipped") {
        problems.push(`${tc.id}「${r.name}」がスキップされています`)
        rows.push({ id: tc.id, result: "スキップ" })
      } else if (isProperRed(r)) {
        rows.push({ id: tc.id, result: `失敗（${r.failureType ?? "?"}: ${firstLine(r.message)}）` })
      } else {
        problems.push(`${tc.id}「${r.name}」がアサーション以外の理由で失敗しています（${r.failureType ?? "?"}: ${firstLine(r.message)}）。シグネチャだけのスタブを置き、本体は未実装の例外を投げるようにしてください`)
        rows.push({ id: tc.id, result: `理由が不適切（${r.failureType ?? "?"}）` })
      }
    }
  }

  for (const r of results.filter((r) => !r.loadError)) {
    const ids = idsOf(r)
    for (const id of ids.filter((id) => !planned.has(id))) problems.push(`${id}「${r.name}」は計画にないテストケースです`)
    if (ids.length === 0 && r.status === "failed") problems.push(`既存のテスト「${r.name}」（${r.file}）が失敗しています: ${firstLine(r.message)}`)
  }
  return { ok: problems.length === 0, problems, rows }
}

function isProperRed(r: TestCaseResult): boolean {
  return /assert/i.test(r.failureType ?? "") || NOT_IMPLEMENTED.test(r.message ?? "")
}

export async function runRed(deps: StepDeps, run: RunState): Promise<StepResult> {
  const worktree = run.worktree
  if (!worktree) return { kind: "error", message: "worktree が記録されていません。setup からやり直してください" }
  const testCheck = deps.config.checks.find((c) => c.junit)
  if (!testCheck) return { kind: "error", message: "harness.config.json の checks に、junit を出力するチェック（テスト）がありません。redVerify にはテストごとの結果が必要です" }
  const model = deps.config.models[MODEL_KEY]?.[0]
  if (!model) return { kind: "error", message: `harness.config.json の models に「${MODEL_KEY}」がありません` }
  const { testCases } = parsePlan(readFileSync(planPath(worktree), "utf8"))

  const common = {
    runId: run.id,
    directory: worktree,
    title: `${run.id}: red`,
    agent: "test-writer",
    model,
    permission: testWriterPermissions(worktree, deps.config.checks.map((c) => c.command)),
  }
  let sessionID = run.sessions?.red
  let prompt = sessionID ? "中断されたので、計画と既存のテストファイルを確認して、続きから進めてください。" : initialPrompt(worktree, testCases)
  let verdict: RedVerdict = { ok: false, problems: [], rows: [] }

  for (let attempt = 0; attempt <= MAX_RETURNS; attempt++) {
    // ID は作った直後に保存し、途中で落ちても次は同じ子セッションで続きから進める
    const result = await deps.child({ ...common, sessionID, prompt, onSession: (id) => deps.store.save({ ...run, sessions: { ...run.sessions, red: id } }) })
    if (result.status === "aborted") return { kind: "error", message: "red の子セッションが中断されました。harness_advance で再開できます" }
    if (result.status === "error") return { kind: "error", message: `red の子セッションがエラーで終わりました: ${result.error}` }
    sessionID = result.sessionID
    deps.store.save({ ...run, sessions: { ...run.sessions, red: sessionID } })

    verdict = await verify(deps, worktree, testCheck, testCases)
    writeRecord(worktree, verdict, attempt)
    deps.store.appendEvent(run.id, { type: "red.verified", attempt, ok: verdict.ok, problems: verdict.problems.length })
    if (verdict.ok) break
    prompt = returnPrompt(verdict.problems)
  }

  const current: RunState = { ...run, sessions: { ...run.sessions, ...(sessionID ? { red: sessionID } : {}) } }
  if (!verdict.ok) {
    deps.store.save({ ...current, status: "escalated" })
    return {
      kind: "escalated",
      message: [`red の検証に ${MAX_RETURNS} 回差し戻しても合格しませんでした（記録: ${join(runDir(worktree), "02-red.md")}）:`, ...verdict.problems.map((p) => `- ${p}`)].join("\n"),
    }
  }

  const commit = await checkpoint(deps, worktree, `test: #${run.issue} のテストを追加（red）`)
  if (typeof commit !== "string") return commit
  // テストをロックする。以降の工程では、権限で編集を拒否し、工程ごとに監査する（#12）
  const lock = createLock(worktree, deps.config.tests.globs, commit)
  deps.store.save({ ...current, step: "green", redCommit: commit })
  deps.store.appendEvent(run.id, { type: "lock.created", commit, files: Object.keys(lock.files).length })
  deps.store.appendEvent(run.id, { type: "step.completed", step: "red", commit })
  return { kind: "continue", message: `red の検証に合格しました（${testCases.length} 件のテストが正しく失敗）。commit ${commit.slice(0, 7)}。次の工程: green` }
}

async function verify(deps: StepDeps, worktree: string, check: { command: string; junit?: string; timeoutSec: number }, testCases: TestCase[]): Promise<RedVerdict> {
  const junitPath = join(worktree, check.junit ?? "")
  rmSync(junitPath, { force: true }) // 前回の結果を読まないように消しておく
  const run = await deps.shell(check.command, { cwd: worktree, timeoutSec: check.timeoutSec })
  if (run.timedOut) return { ok: false, problems: [`テストの実行が ${check.timeoutSec} 秒でタイムアウトしました`], rows: [] }
  if (!existsSync(junitPath))
    return { ok: false, problems: [`テストを実行しても JUnit（${check.junit}）が出力されませんでした。出力の末尾: ${tail(run.stderr || run.stdout)}`], rows: [] }
  return evaluateRed(testCases, parseJUnit(readFileSync(junitPath, "utf8")))
}

// 工程の成果をチェックポイントとして commit する。成功したら commit の SHA を返す
export async function checkpoint(deps: StepDeps, worktree: string, message: string): Promise<string | StepResult> {
  const git = (...args: string[]) => deps.exec("git", args, { cwd: worktree })
  // ハーネス自身（.opencode/）の変更は含めない。opencode は worktree でプラグインの依存を入れるときに .opencode/package.json を書き換える
  const add = await git("add", "-A", "--", ".", ":(exclude).opencode")
  if (add.code !== 0) return { kind: "error", message: `git add に失敗しました: ${add.stderr.trim()}` }
  const commit = await git("commit", "-m", message)
  if (commit.code !== 0 && !/nothing to commit/.test(commit.stdout + commit.stderr))
    return { kind: "error", message: `commit に失敗しました（git の user.name / user.email の設定を確認してください）: ${commit.stderr.trim()}` }
  return (await git("rev-parse", "HEAD")).stdout.trim()
}

// test-writer の権限: 計画などの成果物以外は編集でき、テストの実行コマンドを使える
function testWriterPermissions(worktree: string, checkCommands: string[]): PermissionRule[] {
  const commandPrefixes = [...new Set(checkCommands.map((c) => c.trim().split(/\s+/).slice(0, 2).join(" ")))]
  return [
    ...baseChildPermissions(worktree),
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*.harness*", action: "deny" },
    ...commandPrefixes.map((p) => ({ permission: "bash", pattern: `${p}*`, action: "allow" as const })),
  ]
}

function initialPrompt(worktree: string, testCases: TestCase[]): string {
  return [
    "承認された計画のテストケースを、すべてテストコードにしてください（TDD の Red）。",
    "",
    `- 計画: ${planPath(worktree)}（テストファイルの場所は計画の表に従う）`,
    "- テスト名には必ずテストケースの ID を「[TC-01] ...」の形で含める",
    "- テストが import できるように、実装側には**シグネチャだけのスタブ**を置く。本体は `throw new Error(\"not implemented\")` にし、ロジックは書かない",
    "- テストを実行して、新しいテストがすべてアサーションか未実装の例外で失敗し、既存のテストが通ることを確かめてから終える",
    "",
    "テストケース:",
    ...testCases.map((t) => `- ${t.id}（${t.ac}、${t.kind}）: ${t.content}`),
  ].join("\n")
}

function returnPrompt(problems: string[]): string {
  return ["ハーネスがテストを実行して検証したところ、次の問題がありました。直してください。", ...problems.map((p) => `- ${p}`)].join("\n")
}

function writeRecord(worktree: string, verdict: RedVerdict, attempt: number) {
  const lines = [
    "---",
    `status: ${verdict.ok ? "done" : "failed"}`,
    `attempt: ${attempt}`,
    "---",
    `# red の検証（${verdict.ok ? "合格" : "不合格"}）`,
    "",
    "| ID | 結果 |",
    "|---|---|",
    ...verdict.rows.map((r) => `| ${r.id} | ${r.result.replace(/\|/g, "\\|")} |`),
    ...(verdict.problems.length > 0 ? ["", "## 問題", ...verdict.problems.map((p) => `- ${p}`)] : []),
    "",
  ]
  writeFileSync(join(runDir(worktree), "02-red.md"), lines.join("\n"))
}

const firstLine = (s?: string) => (s ?? "").split(/\r?\n/)[0]?.slice(0, 200) ?? ""
const tail = (s: string) => s.trim().split(/\r?\n/).slice(-5).join(" / ").slice(0, 500)
