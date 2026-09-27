// test-fix の工程（計画 8.2、8.3、#35）
// checks が失敗したら、test-fixer に原因を test-fix/<k>.md に書かせてから直させ、checks に戻す。
// 回数（testFix、autoFixUsed）は、checks から test-fix に入る前に加算して保存する（強制終了で二重に数えない）
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { readFrontmatter } from "../artifacts.ts"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import type { PermissionRule } from "../session.ts"
import { lockPermissions } from "../testing/lock.ts"
import { enforceLock } from "./audit.ts"
import { baseChildPermissions, runDir } from "./common.ts"
import { escalate } from "./escalation.ts"
import { planPath } from "./plan.ts"
import { checkpoint } from "./red.ts"

const MODEL_KEYS = ["dev.test-fix", "dev.implementer"]

export const testFixDir = (worktree: string) => join(runDir(worktree), "test-fix")
const recordPath = (worktree: string, k: number) => join(testFixDir(worktree), `${k}.md`)

// checks が失敗したときに、次に test-fix に進むか、エスカレーションするかを決める
export async function afterChecksFailed(deps: StepDeps, run: RunState, checksRecord: string, fp: string, open: string[]): Promise<StepResult> {
  const loops = deps.config.loops
  const testFix = run.testFix ?? 0
  const used = run.autoFixUsed ?? 0
  const worktree = run.worktree ?? ""
  const base = { history: [...fixHistory(worktree), `checks ${run.checksRuns ?? 0} 回目: 記録 ${checksRecord}（失敗の指紋: ${fp}）`], attempts: fixAttempts(worktree), open }

  // 直した後も同じ指紋が続いていれば、進んでいない
  const recent = (run.fingerprints ?? []).slice(-loops.sameFingerprintLimit)
  if (testFix > 0 && recent.length === loops.sameFingerprintLimit && recent.every((p) => p === fp))
    return escalate(deps, run, { ...base, reason: "no_progress", summary: `直した後も、同じ失敗（指紋 ${fp}）が ${loops.sameFingerprintLimit} 回続きました。` })
  if (testFix >= loops.testFix)
    return escalate(deps, run, { ...base, reason: "loop_exhausted", summary: `test-fix を ${testFix} 回（上限 loops.testFix）繰り返しても、checks が通りませんでした。` })
  if (used >= loops.autoFixBudget)
    return escalate(deps, run, { ...base, reason: "loop_exhausted", summary: `自動の修正（test-fix と review-fix の合計）が上限 autoFixBudget（${loops.autoFixBudget} 回）に達しました。` })

  deps.store.save({ ...run, step: "test-fix", testFix: testFix + 1, autoFixUsed: used + 1 })
  deps.store.appendEvent(run.id, { type: "test-fix.started", k: testFix + 1, fingerprint: fp })
  return { kind: "continue", message: `checks が失敗しました（記録: ${checksRecord}）。test-fix の ${testFix + 1} 回目に進みます` }
}

export async function runTestFix(deps: StepDeps, run: RunState): Promise<StepResult> {
  const worktree = run.worktree
  if (!worktree) return { kind: "error", message: "worktree が記録されていません。setup からやり直してください" }
  const model = MODEL_KEYS.map((k) => deps.config.models[k]?.[0]).find(Boolean)
  if (!model) return { kind: "error", message: `harness.config.json の models に「dev.test-fix」（または dev.implementer）がありません` }

  const k = run.testFix ?? 1
  const record = recordPath(worktree, k)
  const key = `test-fix-${k}`
  const checksRecord = join(runDir(worktree), "checks", `run-${run.checksRuns ?? 1}.md`)

  if (!isDone(record)) {
    const common = { runId: run.id, directory: worktree, title: `${run.id}: test-fix ${k}`, agent: "test-fixer", model, permission: fixerPermissions(worktree, deps, k) }
    const resuming = run.sessions?.[key]
    const save = (sessionID: string) => {
      const latest = deps.store.get(run.id) ?? run
      deps.store.save({ ...latest, sessions: { ...latest.sessions, [key]: sessionID } })
    }
    const first = await deps.child({ ...common, sessionID: resuming, onSession: save, prompt: resuming ? resumePrompt(record) : initialPrompt(worktree, record, checksRecord, k) })
    if (first.status === "aborted") return { kind: "error", message: "test-fix の子セッションが中断されました。harness_advance で、同じ子セッションの続きから再開できます" }
    if (first.status === "error") return { kind: "error", message: `test-fix の子セッションがエラーで終わりました: ${first.error}` }
    // 原因の記録の書き忘れは、同じセッションに 1 回だけ直させる
    if (!isDone(record)) {
      const retry = await deps.child({ ...common, sessionID: first.sessionID, prompt: recordPrompt(record) })
      if (retry.status !== "completed" || !isDone(record))
        return { kind: "error", message: `test-fix の記録（${record}）が完成していません。frontmatter の status: done と「## 原因」「## 修正」が必要です` }
    }
  }

  // commit の前にテストのロックを照合する。変更されていたら元に戻し、この周は失敗として checks に戻す
  const violated = await enforceLock(deps, run)
  if (violated) {
    deps.store.save({ ...(deps.store.get(run.id) ?? run), step: "checks" })
    return { kind: "continue", message: `${violated.message}\ntest-fix の ${k} 回目は失敗として扱い、checks に戻ります` }
  }
  const commit = await checkpoint(deps, worktree, `fix: #${run.issue} の checks の失敗を直す（test-fix ${k}）`)
  if (typeof commit !== "string") return commit
  deps.store.save({ ...(deps.store.get(run.id) ?? run), step: "checks" })
  deps.store.appendEvent(run.id, { type: "step.completed", step: "test-fix", k, commit })
  return { kind: "continue", message: `test-fix の ${k} 回目が完了しました（記録: ${record}）。commit ${commit.slice(0, 7)}。次の工程: checks` }
}

// 記録が完成しているか: status: done と、原因・修正の見出しに中身がある
function isDone(record: string): boolean {
  if (!existsSync(record)) return false
  const text = readFileSync(record, "utf8")
  const section = (title: string) => text.match(new RegExp(`^##\\s*${title}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m"))?.[1]?.trim()
  return readFrontmatter(text).status === "done" && Boolean(section("原因")) && Boolean(section("修正"))
}

// これまでの test-fix の記録（エスカレーションの報告の「試した修正」に載せる）
function fixAttempts(worktree: string): string[] {
  const dir = testFixDir(worktree)
  if (!worktree || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^\d+\.md$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b))
    .map((f) => {
      const cause = readFileSync(join(dir, f), "utf8").match(/^##\s*原因\s*\n+(.+)$/m)?.[1]?.trim() ?? "（原因の記録なし）"
      return `${join(dir, f)}: ${cause}`
    })
}

function fixHistory(worktree: string): string[] {
  return fixAttempts(worktree).map((_, i) => `test-fix ${i + 1} 回目`)
}

// test-fixer の権限: implementer と同じく、テストファイルと成果物は編集できない。自分の記録ファイルだけは書ける
function fixerPermissions(worktree: string, deps: StepDeps, k: number): PermissionRule[] {
  const prefixes = [...new Set(deps.config.checks.map((c) => c.command.trim().split(/\s+/).slice(0, 2).join(" ")))]
  return [
    ...baseChildPermissions(worktree),
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*.harness*", action: "deny" },
    { permission: "edit", pattern: `*test-fix?${k}.md`, action: "allow" },
    ...lockPermissions(deps.config.tests.globs),
    ...prefixes.map((p) => ({ permission: "bash", pattern: `${p}*`, action: "allow" as const })),
  ]
}

function initialPrompt(worktree: string, record: string, checksRecord: string, k: number): string {
  return [
    `checks が失敗しています。原因を調べて、実装を直してください（test-fix の ${k} 回目）。`,
    "",
    `- checks の結果: ${checksRecord}（失敗したテスト、エラーの出力、失敗の指紋）`,
    `- 計画: ${planPath(worktree)}`,
    ...(k > 1 ? [`- これまでの test-fix の記録: ${testFixDir(worktree)}（同じ直し方を繰り返さない）`] : []),
    "",
    "手順:",
    `1. 先に原因を調べ、${record} に書く。frontmatter は status: in_progress、見出しは「## 原因」「## 修正」`,
    "2. 実装を直し、テストを実行して通ることを確かめる",
    "3. 「## 修正」に何をどう直したかを書き、frontmatter を status: done にする",
    "",
    "守ること:",
    "- テストファイルは編集できない（ロックされている）。テストを変えずに、実装だけで直す",
    "- テストに合わせた特別扱い（値のハードコード、テスト専用の分岐）はしない",
    "- テストのほうが仕様（issue の受け入れ基準）と合っていないと判断したら、実装は変えずに「## 原因」にその根拠を書いて終える",
  ].join("\n")
}

function resumePrompt(record: string): string {
  return `中断されたので、${record} と作業ツリーの状態（git status / git diff）を確認して、続きを進めてください。終えたら ${record} の frontmatter を status: done にしてください。`
}

function recordPrompt(record: string): string {
  return `${record} が完成していません。「## 原因」と「## 修正」に中身を書き、frontmatter を status: done にしてください。`
}
