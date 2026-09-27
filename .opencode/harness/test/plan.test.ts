import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advance, record, type StepDeps } from "../machine/dev.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import type { ChildResult, RunChildOptions } from "../session.ts"

const VALID_PLAN = `---
status: done
approved: false
issue: 12
---
# 計画: #12 Add slugify function

## テスト計画
| ID | 対応する AC | 種別 | テストの内容 | テストファイル |
|---|---|---|---|---|
| TC-01 | AC-1 | 正常系 | 英字の空白をハイフンにする | src/slug.test.ts |
| TC-02 | AC-2 | 異常系 | 空文字は空文字を返す | src/slug.test.ts |

## 実装計画
| 手順 | 変更するファイル | 内容 |
|---|---|---|
| 1 | src/slug.ts | slugify を追加 |

## 追加する依存
なし
`

type ChildCall = RunChildOptions & { runId: string }

// 偽の子セッション。呼ばれるたびに writes の先頭の内容を計画ファイルに書く（undefined なら書かない）
const fakeChild = (worktree: string, writes: (string | undefined)[], result?: Partial<ChildResult>) => {
  const calls: ChildCall[] = []
  const run = async (opts: ChildCall): Promise<ChildResult> => {
    calls.push(opts)
    const content = writes.shift()
    if (content !== undefined) writeFileSync(join(worktree, ".harness", "run", "01-plan.md"), content)
    if (result?.status === "error") return { status: "error", sessionID: "ses_plan_1", error: "APIError: Bad Request" }
    return { status: "completed", sessionID: opts.sessionID ?? "ses_plan_1", text: "計画を書きました", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, model: opts.model }
  }
  return { run, calls }
}

const setup = (writes: (string | undefined)[], opts: { models?: Record<string, string[]>; childResult?: Partial<ChildResult> } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "harness-plan-"))
  const worktree = join(root, "wt")
  mkdirSync(join(worktree, ".harness", "run"), { recursive: true })
  writeFileSync(join(worktree, ".harness", "run", "00-issue.md"), "---\nissue: 12\n---\n# #12 Add slugify function\n")
  const store = createStore(root)
  const { run } = startRun(store, { kind: "dev", issue: 12 })
  store.save({ ...run, step: "plan", worktree, branch: "feat/12-add-slugify-function", title: "Add slugify function" })
  const { config } = validateConfig({
    models: opts.models ?? { "dev.plan": ["openai/gpt-6-sol", "openai/gpt-5.5"] },
    checks: [{ name: "test", command: "npm test" }],
    tests: { globs: ["**/*.test.ts"] },
  })
  assert.ok(config)
  const child = fakeChild(worktree, writes, opts.childResult)
  const deps: StepDeps = { root, config, store, exec: async () => ({ code: 0, stdout: "", stderr: "" }), child: child.run }
  const planPath = join(worktree, ".harness", "run", "01-plan.md")
  return { deps, store, child, worktree, planPath, runId: run.id }
}

test("plan の工程で dev-planner の子セッションが計画を書き、承認を求める need_user を返す", async () => {
  const { deps, store, child, worktree, planPath, runId } = setup([VALID_PLAN])
  const result = await advance(deps, runId)

  assert.equal(result.kind, "need_user")
  assert.ok(result.message.includes(planPath))
  assert.match(result.message, /TC-01/)
  assert.match(result.message, /TC-02/)
  assert.match(result.message, /harness_record/)

  const call = child.calls[0]
  assert.ok(call)
  assert.equal(call.agent, "dev-planner")
  assert.equal(call.model, "openai/gpt-6-sol")
  assert.equal(call.directory, worktree)
  assert.equal(call.runId, runId)
  assert.ok(call.prompt.includes("00-issue.md"))
  assert.ok(call.permission?.some((r) => r.permission === "edit" && r.pattern === "*" && r.action === "deny"))
  assert.ok(call.permission?.some((r) => r.permission === "edit" && r.action === "allow" && r.pattern.endsWith("01-plan.md")))

  const run = store.get(runId)
  assert.equal(run?.step, "approval")
  assert.equal(run?.sessions?.plan, "ses_plan_1")
})

test("計画が完了マーカーを欠いていたら、同じ子セッションに 1 回だけ直させる", async () => {
  const draft = VALID_PLAN.replace("status: done", "status: draft")
  const { deps, child, runId } = setup([draft, VALID_PLAN])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "need_user")
  assert.equal(child.calls.length, 2)
  assert.equal(child.calls[1]?.sessionID, "ses_plan_1")
  assert.match(child.calls[1]?.prompt ?? "", /status: done/)
})

test("直させても計画が不完全なら、理由つきのエラーを返し、工程は plan のままにする", async () => {
  const noCases = VALID_PLAN.replace(/\| TC-0\d.*\n/g, "")
  const { deps, store, child, runId } = setup([noCases, noCases])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /テストケース/)
  assert.equal(child.calls.length, 2)
  assert.equal(store.get(runId)?.step, "plan")
})

test("子セッションがエラーで終わったら、エラーを返し、工程は plan のままにする", async () => {
  const { deps, store, runId } = setup([undefined], { childResult: { status: "error" } })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /Bad Request/)
  assert.equal(store.get(runId)?.step, "plan")
})

test("models に dev.plan がなければ、子セッションを作らずにエラーを返す", async () => {
  const { deps, child, runId } = setup([VALID_PLAN], { models: {} })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /dev\.plan/)
  assert.equal(child.calls.length, 0)
})

test("承認待ちの間に advance を呼んでも、子セッションを動かさずに need_user を返す", async () => {
  const { deps, child, runId } = setup([VALID_PLAN])
  await advance(deps, runId)
  const again = await advance(deps, runId)
  assert.equal(again.kind, "need_user")
  assert.equal(child.calls.length, 1)
})

test("承認すると工程が red に進み、承認の記録と計画の approved: true が残る", async () => {
  const { deps, store, worktree, planPath, runId } = setup([VALID_PLAN])
  await advance(deps, runId)
  const result = record(deps, { run: runId, gate: "plan", decision: "approved" })
  assert.equal(result.kind, "continue")
  assert.equal(store.get(runId)?.step, "red")
  assert.match(readFileSync(planPath, "utf8"), /approved: true/)
  assert.match(readFileSync(join(worktree, ".harness", "run", "gates", "plan.md"), "utf8"), /decision: approved/)
})

test("修正指示を記録すると plan に戻り、次の advance で同じ子セッションに指示を送って、再び承認を求める", async () => {
  const revised = VALID_PLAN.replace("| TC-02 |", "| TC-03 | AC-2 | 境界値 | 記号だけなら空文字 | src/slug.test.ts |\n| TC-02 |")
  const { deps, store, child, worktree, runId } = setup([VALID_PLAN, revised])
  await advance(deps, runId)
  const recorded = record(deps, { run: runId, gate: "plan", decision: "changes_requested", feedback: "記号だけの入力の境界値テストを追加して" })
  assert.equal(recorded.kind, "continue")
  assert.equal(store.get(runId)?.step, "plan")
  assert.ok(existsSync(join(worktree, ".harness", "run", "gates", "plan-feedback-1.md")))

  const result = await advance(deps, runId)
  assert.equal(result.kind, "need_user")
  assert.match(result.message, /TC-03/)
  assert.equal(child.calls[1]?.sessionID, "ses_plan_1")
  assert.match(child.calls[1]?.prompt ?? "", /記号だけの入力の境界値テストを追加して/)
  assert.equal(store.get(runId)?.feedback, undefined)
})

test("修正指示に内容がなければエラーにする", async () => {
  const { deps, runId } = setup([VALID_PLAN])
  await advance(deps, runId)
  const result = record(deps, { run: runId, gate: "plan", decision: "changes_requested", feedback: "  " })
  assert.equal(result.kind, "error")
})

test("中断を記録すると run は interrupted になる", async () => {
  const { deps, store, runId } = setup([VALID_PLAN])
  await advance(deps, runId)
  const result = record(deps, { run: runId, gate: "plan", decision: "aborted" })
  assert.equal(result.kind, "done")
  assert.equal(store.get(runId)?.status, "interrupted")
})

test("承認待ちでないときに plan の判断を記録しようとしたらエラーにする", async () => {
  const { deps, runId } = setup([VALID_PLAN])
  const result = record(deps, { run: runId, gate: "plan", decision: "approved" })
  assert.equal(result.kind, "error")
  assert.match(result.message, /承認待ち/)
})
