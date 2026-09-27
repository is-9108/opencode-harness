// green の工程（計画 8.2）
// implementer に、ロックされたテストを通す最小のコードをテストケースごとに書かせる。
// 進み具合は 03-green-log.md のチェックボックスに記録させ、中断しても同じ子セッションで続きから再開できるようにする
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readFrontmatter } from "../artifacts.ts"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import type { PermissionRule } from "../session.ts"
import { lockPermissions } from "../testing/lock.ts"
import { enforceLock } from "./audit.ts"
import { baseChildPermissions, runDir } from "./common.ts"
import { parsePlan, planPath, type TestCase } from "./plan.ts"
import { checkpoint } from "./red.ts"

const MODEL_KEY = "dev.implementer"
const LOG_FILE = "03-green-log.md"

export async function runGreen(deps: StepDeps, run: RunState): Promise<StepResult> {
  const worktree = run.worktree
  if (!worktree) return { kind: "error", message: "worktree が記録されていません。setup からやり直してください" }
  const model = deps.config.models[MODEL_KEY]?.[0]
  if (!model) return { kind: "error", message: `harness.config.json の models に「${MODEL_KEY}」がありません` }

  const { testCases } = parsePlan(readFileSync(planPath(worktree), "utf8"))
  const logPath = join(runDir(worktree), LOG_FILE)
  if (!existsSync(logPath)) writeFileSync(logPath, renderLog(testCases))

  const common = {
    runId: run.id,
    directory: worktree,
    title: `${run.id}: green`,
    agent: "implementer",
    model,
    permission: implementerPermissions(worktree, deps),
  }
  const resuming = run.sessions?.green
  const save = (sessionID: string | undefined) => {
    if (sessionID) deps.store.save({ ...run, sessions: { ...run.sessions, green: sessionID } })
  }

  const first = await deps.child({ ...common, sessionID: resuming, prompt: resuming ? resumePrompt(logPath) : initialPrompt(worktree, logPath, testCases) })
  save(first.sessionID)
  if (first.status === "aborted") return { kind: "error", message: "green の子セッションが中断されました。harness_advance で、同じ子セッションの続きから再開できます" }
  if (first.status === "error") return { kind: "error", message: `green の子セッションがエラーで終わりました: ${first.error}` }

  // チェックの付け忘れや完了マーカーの書き忘れは、同じセッションに 1 回だけ直させる
  let remaining = unfinished(logPath, testCases)
  if (remaining.length > 0) {
    const retry = await deps.child({ ...common, sessionID: first.sessionID, prompt: fixPrompt(logPath, remaining) })
    if (retry.status !== "completed") return { kind: "error", message: `green の子セッションが完了しませんでした: ${retry.status === "error" ? retry.error : "中断"}` }
    remaining = unfinished(logPath, testCases)
    if (remaining.length > 0) return { kind: "error", message: [`green が終わっていません（${logPath}）:`, ...remaining.map((r) => `- ${r}`)].join("\n") }
  }

  // commit の前にテストのロックを照合する（改ざんされたテストを commit に入れないため）
  const violated = await enforceLock(deps, run)
  if (violated) return violated

  const commit = await checkpoint(deps, worktree, `feat: #${run.issue} を実装（green）`)
  if (typeof commit !== "string") return commit
  const latest = deps.store.get(run.id) ?? run
  deps.store.save({ ...latest, step: "checks", greenCommit: commit })
  deps.store.appendEvent(run.id, { type: "step.completed", step: "green", commit })
  return { kind: "continue", message: `green が完了しました（${testCases.length} 件）。commit ${commit.slice(0, 7)}。次の工程: checks` }
}

// 未完了のケースと、完了マーカーの有無を返す
function unfinished(logPath: string, testCases: TestCase[]): string[] {
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
  const problems = testCases.filter((t) => !new RegExp(`^- \\[x\\] ${t.id}\\b`, "mi").test(log)).map((t) => `${t.id} にチェックが付いていません`)
  if (readFrontmatter(log).status !== "done") problems.push("03-green-log.md の frontmatter が status: done になっていません")
  return problems
}

// implementer の権限。後のルールが優先されるので、広い許可の後に、成果物とテストの拒否を置く
function implementerPermissions(worktree: string, deps: StepDeps): PermissionRule[] {
  const prefixes = [...new Set(deps.config.checks.map((c) => c.command.trim().split(/\s+/).slice(0, 2).join(" ")))]
  return [
    ...baseChildPermissions(worktree),
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*.harness*", action: "deny" },
    { permission: "edit", pattern: `*${LOG_FILE}`, action: "allow" },
    ...lockPermissions(deps.config.tests.globs),
    ...prefixes.map((p) => ({ permission: "bash", pattern: `${p}*`, action: "allow" as const })),
  ]
}

function renderLog(testCases: TestCase[]): string {
  return [
    "---",
    "status: in_progress",
    "---",
    "# green の記録",
    "",
    "テストケースを 1 つずつ通し、通ったらチェックを付ける。すべて終えたら status を done にする。",
    "",
    ...testCases.map((t) => `- [ ] ${t.id}（${t.ac}、${t.kind}）: ${t.content}`),
    "",
  ].join("\n")
}

function initialPrompt(worktree: string, logPath: string, testCases: TestCase[]): string {
  return [
    "red で書かれたテストを通す、最小のコードを書いてください（TDD の Green）。",
    "",
    `- 計画: ${planPath(worktree)}（実装計画に従う）`,
    `- 進み具合の記録: ${logPath}。テストケースを 1 つずつ通し、通ったらそのケースにチェック（- [x]）を付ける。すべて終えたら frontmatter を status: done にする`,
    "- テストファイルは編集できない（ロックされている）。テストを変えずに、実装だけで通す",
    "- テストに合わせた特別扱い（値のハードコード、テスト専用の分岐）はしない。後のレビューで仕様違反・テストの捻じ曲げとして差し戻される",
    "",
    "テストケース:",
    ...testCases.map((t) => `- ${t.id}（${t.ac}、${t.kind}）: ${t.content}`),
  ].join("\n")
}

function resumePrompt(logPath: string): string {
  return `中断されたので、${logPath} と作業ツリーの状態（git status / git diff）を確認して、チェックが付いていないテストケースから続きを進めてください。`
}

function fixPrompt(logPath: string, problems: string[]): string {
  return [`${logPath} を確認したところ、次が終わっていません。残りを進めてください。`, ...problems.map((p) => `- ${p}`)].join("\n")
}
