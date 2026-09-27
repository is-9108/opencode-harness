import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { advance } from "../machine/dev.ts"
import { FAIL, PASS, fixIt, git, setupLoop as setup, type Behave } from "./loop-fixture.ts"

const VIOLATION = "| F-01 | spec_violation | yes | AC-2 | src/slug.ts:1 | 記号だけの入力で空文字を返していない |"
const OTHER_VIOLATION = "| F-01 | spec_violation | yes | AC-3 | src/other.ts:1 | 長さの上限を守っていない |"

// reviewer: 依頼にある出力先に、指摘の表を書く
const reviewer =
  (...rows: string[]): Behave =>
  (_wt, call) => {
    const output = call.prompt.match(/出力先: (\S+?)（/)?.[1]
    assert.ok(output, "レビューの依頼に出力先がない")
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `---\nstatus: done\nperspective: spec\n---\n## 指摘\n| ID | 分類 | blocking | AC | 根拠（ファイル:行） | 内容 |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`)
    return "completed"
  }

// review-fixer: 依頼にある記録ファイルに対応を書き、実装を少し変える
const fixer: Behave = (wt, call) => {
  const record = call.prompt.match(/[^\s（、]*review-fix[\\/]\d+\.md/)?.[0]
  assert.ok(record, "review-fix の依頼に記録ファイルがない")
  const k = record.match(/(\d+)\.md$/)?.[1]
  mkdirSync(dirname(record), { recursive: true })
  writeFileSync(record, `---\nstatus: done\n---\n## 対応\nF-01: 直した\n\n## 修正\n記号だけの入力を空文字にした（${k} 回目）\n`)
  writeFileSync(join(wt, "src", "slug.ts"), `export const slugify = (s: string) => s.replace(/ /g, "-") // review-fix ${k}\n`)
  return "completed"
}

test("blocking の指摘 1 件を review-fix が直し、checks → review に戻って解消すれば pr に進む（AC-1）", async () => {
  const { store, worktree, calls, drive, runId } = setup([PASS], [reviewer(VIOLATION), fixer, reviewer()])
  const result = await drive(20, "pr")
  assert.equal(result.kind, "continue")
  const run = store.get(runId)
  assert.equal(run?.step, "pr")
  assert.equal(run?.reviewFix, 1)
  assert.equal(run?.reviewRounds, 2)
  assert.equal(run?.checksRuns, 2)
  assert.deepEqual(calls.map((c) => c.agent), ["reviewer", "review-fixer", "reviewer"])

  const fix = calls[1]!
  assert.equal(fix.model, "openai/gpt-5.7")
  assert.match(fix.prompt, /reviews[\\/]round-1[\\/]summary\.md/)
  assert.match(fix.prompt, /blocking/)
  // テストファイルの編集は権限で拒否し、自分の記録ファイルだけは書ける
  assert.ok(fix.permission?.some((r) => r.permission === "edit" && r.action === "deny" && r.pattern.includes("test")))
  assert.ok(fix.permission?.some((r) => r.permission === "edit" && r.action === "allow" && r.pattern.includes("review-fix")))
  assert.match(git(worktree, "log", "-1", "--format=%s"), /review-fix 1/)

  // 2 周目は、前回からの差分と前回の blocking の指摘だけを見させる
  const second = calls[2]!
  assert.match(second.prompt, /2 周目以降/)
  assert.match(second.prompt, /reviews[\\/]round-1[\\/]summary\.md/)
  const diff = readFileSync(join(worktree, ".harness", "run", "reviews", "round-2", "input.diff"), "utf8")
  assert.match(diff, /review-fix 1/)
  assert.doesNotMatch(diff, /diff --git a\/src\/slug\.test\.ts/)
})

test("2 周で解消すれば pr に進む", async () => {
  const { store, drive, runId } = setup([PASS], [reviewer(VIOLATION), fixer, reviewer(VIOLATION), fixer, reviewer()])
  await drive(30, "pr")
  const run = store.get(runId)
  assert.equal(run?.step, "pr")
  assert.equal(run?.reviewFix, 2)
  assert.equal(run?.autoFixUsed, 2)
  // 続けて出た指摘は、再発ではない
  assert.deepEqual(run?.findingRounds, { "spec:AC-2:src/slug.ts": [1, 2] })
})

test("3 周直しても blocking が残れば、4 周目に入る前に loop_exhausted でエスカレーションする（AC-2）", async () => {
  const { store, calls, drive, runId } = setup([PASS], [reviewer(VIOLATION), fixer, reviewer(VIOLATION), fixer, reviewer(VIOLATION), fixer, reviewer(VIOLATION)])
  const result = await drive(40, "pr")
  assert.equal(result.kind, "escalated")
  assert.equal(calls.filter((c) => c.agent === "review-fixer").length, 3)
  const run = store.get(runId)
  assert.equal(run?.lastEscalation?.reason, "loop_exhausted")
  assert.equal(run?.reviewFix, 3)
  assert.equal(run?.step, "review")
  assert.equal(run?.mode, "human")
  const report = readFileSync(run!.lastEscalation!.report, "utf8")
  assert.match(report, /review-fix を 3 回/)
  // 試した修正として review-fix の記録を、経緯として各周の集計を載せる
  assert.match(report, /## 試した修正[\s\S]*review-fix[\\/]1\.md: 記号だけの入力を空文字にした（1 回目）/)
  assert.match(report, /## 止まるまでの経緯[\s\S]*review 4 周目/)
  assert.match(report, /## 未解決の論点[\s\S]*F-01/)
})

test("1 周目の指摘が 2 周目で解消し、3 周目で再び出たら oscillation でエスカレーションする（AC-3）", async () => {
  const { store, calls, drive, runId } = setup([PASS], [reviewer(VIOLATION), fixer, reviewer(OTHER_VIOLATION), fixer, reviewer(VIOLATION)])
  const result = await drive(30, "pr")
  assert.equal(result.kind, "escalated")
  assert.match(result.message, /spec:AC-2:src\/slug\.ts/)
  const run = store.get(runId)
  assert.equal(run?.lastEscalation?.reason, "oscillation")
  assert.equal(run?.reviewFix, 2)
  assert.equal(calls.filter((c) => c.agent === "review-fixer").length, 2)
  assert.deepEqual(run?.findingRounds, { "spec:AC-2:src/slug.ts": [1, 3], "spec:AC-3:src/other.ts": [2] })
})

test("test-fix と review-fix の合計が autoFixBudget に達したら、次の review-fix に入る前にエスカレーションする（AC-5）", async () => {
  const { store, calls, drive, runId } = setup([FAIL(), PASS], [fixIt, reviewer(VIOLATION), fixer, reviewer(VIOLATION)], { loops: { autoFixBudget: 2 } })
  const result = await drive(30, "pr")
  assert.equal(result.kind, "escalated")
  assert.deepEqual(calls.map((c) => c.agent), ["test-fixer", "reviewer", "review-fixer", "reviewer"])
  const run = store.get(runId)
  assert.equal(run?.lastEscalation?.reason, "loop_exhausted")
  assert.match(result.message, /autoFixBudget/)
  assert.equal(run?.testFix, 1)
  assert.equal(run?.reviewFix, 1)
  assert.equal(run?.autoFixUsed, 2)
})

test("review-fixer がテストファイルを変更したら、ロックの監査で元に戻し、その周は失敗として checks に戻る", async () => {
  const tamper: Behave = (wt, call, k) => {
    fixer(wt, call, k)
    writeFileSync(join(wt, "src", "slug.test.ts"), "test('[TC-01] a', () => {}) // 捻じ曲げ\n")
    return "completed"
  }
  const { deps, store, worktree, runId } = setup([PASS], [reviewer(VIOLATION), tamper])
  await advance(deps, runId) // checks → review
  await advance(deps, runId) // review → review-fix
  const result = await advance(deps, runId)
  assert.match(result.message, /元に戻しました/)
  // Windows の git は、元に戻したファイルの改行を CRLF にすることがある
  assert.equal(readFileSync(join(worktree, "src", "slug.test.ts"), "utf8").replace(/\r\n/g, "\n"), "test('[TC-01] a')\n")
  assert.equal(store.get(runId)?.step, "checks")
  assert.equal(store.get(runId)?.reviewFix, 1)
  assert.doesNotMatch(git(worktree, "log", "-1", "--format=%s"), /review-fix/)
})

test("review-fix の途中で強制終了しても、再開すると同じ子セッションで続きから進み、回数は二重に数えない", async () => {
  const { deps, store, calls, runId } = setup([PASS], [reviewer(VIOLATION), "throw", fixer])
  await advance(deps, runId) // checks → review
  await advance(deps, runId) // review → review-fix
  await assert.rejects(advance(deps, runId), /強制終了/)
  const sessionID = store.get(runId)?.sessions?.["review-fix-1"]
  assert.ok(sessionID)
  const resumed = await advance(deps, runId)
  assert.equal(resumed.kind, "continue")
  assert.equal(calls.at(-1)?.sessionID, sessionID)
  assert.match(calls.at(-1)?.prompt ?? "", /中断されたので/)
  assert.equal(store.get(runId)?.step, "checks")
  assert.equal(store.get(runId)?.reviewFix, 1)
  assert.equal(store.get(runId)?.autoFixUsed, 1)
})
