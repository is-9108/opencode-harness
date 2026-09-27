import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { advance } from "../machine/dev.ts"
import { FAIL, PASS, fixIt, git, setupLoop as setup, type Behave, type Call } from "./loop-fixture.ts"

test("checks が失敗したら test-fix に進み、test-fixer が原因を記録して直し、checks に戻って通れば review に進む（AC-1）", async () => {
  const { deps, store, worktree, calls, runId } = setup([FAIL(), PASS])

  const first = await advance(deps, runId)
  assert.equal(first.kind, "continue")
  assert.equal(store.get(runId)?.step, "test-fix")
  // 回数は工程を始める前に加算して保存する
  assert.equal(store.get(runId)?.testFix, 1)
  assert.equal(store.get(runId)?.autoFixUsed, 1)

  const fixed = await advance(deps, runId)
  assert.equal(fixed.kind, "continue")
  assert.equal(calls[0]?.agent, "test-fixer")
  assert.equal(calls[0]?.model, "openai/gpt-5.6-sol")
  const prompt = calls[0]?.prompt ?? ""
  assert.match(prompt, /checks[\\/]run-1\.md/)
  assert.match(prompt, /test-fix[\\/]1\.md/)
  assert.match(prompt, /原因/)
  // テストファイルの編集は権限で拒否する
  assert.ok(calls[0]?.permission?.some((r) => r.permission === "edit" && r.action === "deny" && r.pattern.includes("test")))
  assert.equal(store.get(runId)?.step, "checks")
  assert.match(git(worktree, "log", "-1", "--format=%s"), /test-fix/)

  const after = await advance(deps, runId)
  assert.equal(after.kind, "continue")
  assert.equal(store.get(runId)?.step, "review")
})

test("3 回直しても通らなければ、4 回目に入る前に loop_exhausted でエスカレーションする（AC-2）", async () => {
  // 毎回違うテストが失敗する（指紋は毎回変わる）
  const { store, calls, drive, runId } = setup([FAIL("[TC-01] a"), FAIL("[TC-02] b"), FAIL("[TC-03] c"), FAIL("[TC-04] d")])
  const result = await drive()
  assert.equal(result.kind, "escalated")
  assert.equal(calls.length, 3)
  const run = store.get(runId)
  assert.equal(run?.lastEscalation?.reason, "loop_exhausted")
  assert.equal(run?.testFix, 3)
  // 試した修正として、test-fix の記録を報告に載せる
  const report = readFileSync(run!.lastEscalation!.report, "utf8")
  assert.match(report, /## 試した修正[\s\S]*test-fix[\\/]1\.md[\s\S]*境界値の扱いが逆だった（1 回目）/)
})

test("直した後も同じ指紋の失敗が 2 回続いたら、上限を待たずに no_progress でエスカレーションする（AC-3）", async () => {
  const { store, calls, drive, runId } = setup([FAIL(), FAIL()])
  const result = await drive()
  assert.equal(result.kind, "escalated")
  assert.equal(calls.length, 1)
  assert.equal(store.get(runId)?.lastEscalation?.reason, "no_progress")
})

test("test-fixer がテストファイルを変更したら、ロックの監査で元に戻し、その周は失敗として checks に戻る（AC-4）", async () => {
  const tamper: Behave = (wt, call, k) => {
    fixIt(wt, call, k)
    writeFileSync(join(wt, "src", "slug.test.ts"), "test('[TC-01] a', () => {}) // 捻じ曲げ\n")
    return "completed"
  }
  const { deps, store, worktree, runId } = setup([FAIL(), FAIL("[TC-02] b")], [tamper])
  await advance(deps, runId) // checks → test-fix
  const result = await advance(deps, runId)
  assert.match(result.message, /元に戻しました/)
  // Windows の git は、元に戻したファイルの改行を CRLF にすることがある
  assert.equal(readFileSync(join(worktree, "src", "slug.test.ts"), "utf8").replace(/\r\n/g, "\n"), "test('[TC-01] a')\n")
  assert.equal(store.get(runId)?.step, "checks")
  assert.equal(store.get(runId)?.testFix, 1)
  // 改ざんしたテストは commit に入れない
  assert.doesNotMatch(git(worktree, "log", "-1", "--format=%s"), /test-fix/)
})

test("test-fix の途中で強制終了しても、再開すると同じ子セッションで続きから進み、回数は二重に数えない（AC-5）", async () => {
  const { deps, store, calls, runId } = setup([FAIL(), PASS], ["throw"])
  await advance(deps, runId) // checks → test-fix
  await assert.rejects(advance(deps, runId), /強制終了/)
  assert.equal(store.get(runId)?.sessions?.["test-fix-1"], "ses_fix_1")

  const resumed = await advance(deps, runId)
  assert.equal(resumed.kind, "continue")
  assert.equal(calls[1]?.sessionID, "ses_fix_1")
  assert.match(calls[1]?.prompt ?? "", /続き/)
  assert.equal(store.get(runId)?.testFix, 1)
  assert.equal(store.get(runId)?.autoFixUsed, 1)
})

test("test-fix と review-fix の合計が autoFixBudget に達したら、次の fix に入る前にエスカレーションする", async () => {
  const { store, calls, drive, runId } = setup([FAIL("[TC-01] a"), FAIL("[TC-02] b"), FAIL("[TC-03] c")], [], {
    loops: { testFix: 3, reviewFix: 3, autoFixBudget: 2, reviewRoundsInHumanMode: 1, sameFingerprintLimit: 2 },
  })
  const result = await drive()
  assert.equal(result.kind, "escalated")
  assert.equal(calls.length, 2)
  assert.match(store.get(runId)?.lastEscalation?.report ?? "", /escalation-1\.md/)
  assert.match(readFileSync(store.get(runId)!.lastEscalation!.report, "utf8"), /autoFixBudget/)
})

test("原因の記録を書き忘れたら、同じ子セッションに 1 回だけ書かせる。それでも書かなければエラーにする", async () => {
  const lazy: Behave = (wt) => {
    writeFileSync(join(wt, "src", "slug.ts"), "export const slugify = (s: string) => s.trim()\n")
    return "completed"
  }
  const { deps, calls, runId } = setup([FAIL()], [lazy, lazy])
  await advance(deps, runId)
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.sessionID, "ses_fix_1")
  assert.match(calls[1]?.prompt ?? "", /test-fix[\\/]1\.md/)
})

test("models に dev.test-fix がなければ、実装役（dev.implementer）のモデルを使う", async () => {
  const { deps, calls, runId } = setup([FAIL(), PASS], [], { models: { "dev.implementer": ["openai/gpt-5.5"] } })
  await advance(deps, runId)
  await advance(deps, runId)
  assert.equal(calls[0]?.model, "openai/gpt-5.5")
})

test("test-fix の記録が完了していれば、再開しても子セッションを呼ばずに commit して checks に戻る", async () => {
  const { deps, store, worktree, calls, runId } = setup([FAIL(), PASS])
  await advance(deps, runId)
  fixIt(worktree, {} as Call, 1)
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  assert.equal(calls.length, 0)
  assert.equal(store.get(runId)?.step, "checks")
  assert.ok(existsSync(join(worktree, ".harness", "run", "test-fix", "1.md")))
})
