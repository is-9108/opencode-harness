// plan の工程と、その承認（計画 8.2 の plan / approval）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readFrontmatter, setFrontmatter } from "../artifacts.ts"
import type { RecordInput, StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import { baseChildPermissions, editOnly, gatesDir, readTemplate, runDir } from "./common.ts"

const PLAN_FILE = "01-plan.md"
const MODEL_KEY = "dev.plan"

export type TestCase = { id: string; ac: string; kind: string; content: string }

export function planPath(worktree: string) {
  return join(runDir(worktree), PLAN_FILE)
}

// 計画ファイルを読み、テストケースと不足を返す
export function parsePlan(content: string): { testCases: TestCase[]; problems: string[] } {
  const problems: string[] = []
  if (readFrontmatter(content).status !== "done") problems.push("frontmatter の status が done になっていません（書き終えたら status: done にしてください）")
  const testCases: TestCase[] = []
  for (const line of content.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim())
    const id = cells[1]
    if (!id || !/^TC-\d+$/.test(id)) continue
    testCases.push({ id, ac: cells[2] ?? "", kind: cells[3] ?? "", content: cells[4] ?? "" })
  }
  if (testCases.length === 0) problems.push("テスト計画の表にテストケース（TC-01 など）が 1 件もありません")
  for (const tc of testCases) {
    if (!tc.ac) problems.push(`${tc.id} に対応する AC が書かれていません`)
    if (!tc.content) problems.push(`${tc.id} にテストの内容が書かれていません`)
  }
  const ids = testCases.map((t) => t.id)
  for (const dup of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`テストケースの ID ${dup} が重複しています`)
  return { testCases, problems }
}

export async function runPlan(deps: StepDeps, run: RunState): Promise<StepResult> {
  const worktree = run.worktree
  if (!worktree) return { kind: "error", message: "worktree が記録されていません。setup からやり直してください" }
  const model = deps.config.models[MODEL_KEY]?.[0]
  if (!model) return { kind: "error", message: `harness.config.json の models に「${MODEL_KEY}」がありません` }

  const path = planPath(worktree)
  const permission = [...baseChildPermissions(worktree), ...editOnly(PLAN_FILE)]
  const common = { runId: run.id, directory: worktree, title: `${run.id}: plan`, agent: "dev-planner", model, permission }

  const previous = run.sessions?.plan
  const first = await deps.child({
    ...common,
    sessionID: run.feedback && previous ? previous : undefined,
    prompt: run.feedback && previous ? revisePrompt(path, run.feedback) : initialPrompt(worktree, path),
  })
  if (first.status !== "completed") return childFailed(first)
  const sessions = { ...run.sessions, plan: first.sessionID }
  deps.store.save({ ...run, sessions })

  // 完了マーカーや表の書き忘れは、同じセッションに 1 回だけ直させる（計画 13 章）
  let parsed = parsePlan(readIfExists(path))
  if (parsed.problems.length > 0) {
    const retry = await deps.child({ ...common, sessionID: first.sessionID, prompt: fixPrompt(path, parsed.problems) })
    if (retry.status !== "completed") return childFailed(retry)
    parsed = parsePlan(readIfExists(path))
    if (parsed.problems.length > 0)
      return { kind: "error", message: [`計画が不完全です（${path}）:`, ...parsed.problems.map((p) => `- ${p}`)].join("\n") }
  }

  const { feedback: _, ...rest } = run
  deps.store.save({ ...rest, sessions, step: "approval" })
  deps.store.appendEvent(run.id, { type: "step.completed", step: "plan", testCases: parsed.testCases.length })
  return approvalRequest(run, path, parsed.testCases)
}

// 承認待ちの間に advance が呼ばれたときは、もう一度承認を求める
export function waitApproval(run: RunState): StepResult {
  const path = planPath(run.worktree ?? "")
  return approvalRequest(run, path, parsePlan(readIfExists(path)).testCases)
}

export function recordPlan(deps: StepDeps, run: RunState, input: RecordInput): StepResult {
  if (run.step !== "approval") return { kind: "error", message: `${run.id} は計画の承認待ちではありません（現在の工程: ${run.step}）` }
  const worktree = run.worktree ?? ""
  const gates = gatesDir(worktree)
  mkdirSync(gates, { recursive: true })
  const at = (deps.now?.() ?? new Date()).toISOString()

  switch (input.decision) {
    case "approved": {
      const path = planPath(worktree)
      writeFileSync(path, setFrontmatter(readFileSync(path, "utf8"), "approved", "true"))
      writeFileSync(join(gates, "plan.md"), `---\ngate: plan\ndecision: approved\nat: ${at}\n---\n`)
      deps.store.save({ ...run, step: "red" })
      deps.store.appendEvent(run.id, { type: "gate.recorded", gate: "plan", decision: "approved" })
      return { kind: "continue", message: "計画を承認しました。次の工程: red（テストを書く）" }
    }
    case "changes_requested": {
      const feedback = input.feedback?.trim()
      if (!feedback) return { kind: "error", message: "修正指示の内容（feedback）が空です。ユーザーに具体的な修正内容を聞いてください" }
      const count = (run.feedbackCount ?? 0) + 1
      writeFileSync(join(gates, `plan-feedback-${count}.md`), `---\ngate: plan\ndecision: changes_requested\nat: ${at}\n---\n\n${feedback}\n`)
      deps.store.save({ ...run, step: "plan", feedback, feedbackCount: count })
      deps.store.appendEvent(run.id, { type: "gate.recorded", gate: "plan", decision: "changes_requested", count })
      return { kind: "continue", message: "修正指示を記録しました。harness_advance を呼ぶと、同じ planner が計画を直します" }
    }
    case "aborted": {
      writeFileSync(join(gates, "plan.md"), `---\ngate: plan\ndecision: aborted\nat: ${at}\n---\n`)
      deps.store.save({ ...run, status: "interrupted" })
      deps.store.appendEvent(run.id, { type: "gate.recorded", gate: "plan", decision: "aborted" })
      return { kind: "done", message: `${run.id} を中断しました。再開するときは、ユーザーに確認してから進めてください` }
    }
  }
}

function approvalRequest(run: RunState, path: string, testCases: TestCase[]): StepResult {
  return {
    kind: "need_user",
    message: [
      `計画ができました。ユーザーに承認を求めてください。`,
      `計画: ${path}`,
      "",
      `テストケース（${testCases.length} 件）:`,
      ...testCases.map((t) => `- ${t.id}（${t.ac}、${t.kind}）: ${t.content}`),
      "",
      "手順:",
      "1. 上の要約を示す。方針・実装計画・追加する依存・確認したいことは、計画ファイルを読んで短く補足する",
      "2. question ツールで「承認 / 修正指示 / 中断」を聞く。修正指示なら、具体的な内容も聞く",
      `3. harness_record(run: "${run.id}", gate: "plan", decision: "approved" | "changes_requested" | "aborted", feedback: 修正指示の内容) を呼ぶ`,
      "計画ファイルを自分で編集しないこと（修正は planner に任せる）",
    ].join("\n"),
  }
}

function initialPrompt(worktree: string, path: string): string {
  return [
    "次の issue について、テスト計画と実装計画を作ってください。",
    "",
    `- issue: ${join(runDir(worktree), "00-issue.md")} を読む`,
    "- リポジトリのコードを読み、既存の構成・命名・テストの書き方に合わせる。docs/requirements/ があれば要件定義書も参照する",
    `- 出力先: ${path}（このファイル以外は編集できない）`,
    "- 下の雛形の構成に従う。書き終えたら frontmatter の status を done にする",
    "",
    "雛形:",
    "```markdown",
    readTemplate("dev/01-plan.md").trim(),
    "```",
  ].join("\n")
}

function revisePrompt(path: string, feedback: string): string {
  return [
    `ユーザーから計画（${path}）への修正指示がありました。指示に沿って計画を直してください。`,
    "直し終えたら frontmatter の status を done のままにしておくこと。",
    "",
    "修正指示:",
    feedback,
  ].join("\n")
}

function fixPrompt(path: string, problems: string[]): string {
  return [`計画（${path}）に次の不足があります。直してください。`, ...problems.map((p) => `- ${p}`), "", "直し終えたら frontmatter を status: done にすること。"].join("\n")
}

function childFailed(result: { status: "error" | "aborted"; error?: string }): StepResult {
  if (result.status === "aborted") return { kind: "error", message: "plan の子セッションが中断されました。harness_advance で再開できます" }
  return { kind: "error", message: `plan の子セッションがエラーで終わりました: ${result.error}` }
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}
