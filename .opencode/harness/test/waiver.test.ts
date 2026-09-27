import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { advance } from "../machine/dev.ts"
import { readWaivers, waive } from "../steps/waiver.ts"
import { PASS, fixer, reviewer, setupLoop as setup } from "./loop-fixture.ts"

const VIOLATION = "| F-01 | spec_violation | yes | AC-2 | src/slug.ts:1 | 記号だけの入力で空文字を返していない |"
const KEY = "spec:AC-2:src/slug.ts"

// checks → review まで進め、blocking の指摘で review-fix に入ったところで止める
const reviewOnce = async (ctx: ReturnType<typeof setup>) => {
  await advance(ctx.deps, ctx.runId) // checks → review
  await advance(ctx.deps, ctx.runId) // review → review-fix
  assert.equal(ctx.store.get(ctx.runId)?.step, "review-fix")
}

test("免除した指摘は、次のレビューで同じ ID の指摘が出ても blocking に数えず、pr に進む（AC-1）", async () => {
  const ctx = setup([PASS], [reviewer(VIOLATION), fixer, reviewer(VIOLATION)])
  await reviewOnce(ctx)
  // 最新のレビューの番号（F-01）でも免除できる
  const result = waive(ctx.deps, { run: ctx.runId, finding: "F-01", reason: "AC-2 は次の issue で見直すため" })
  assert.equal(result.kind, "done")
  assert.match(result.message, new RegExp(KEY))
  assert.deepEqual(readWaivers(ctx.worktree), [{ key: KEY, finding: "F-01: 記号だけの入力で空文字を返していない", reason: "AC-2 は次の issue で見直すため", at: readWaivers(ctx.worktree)[0]!.at }])

  await ctx.drive(20, "pr")
  const run = ctx.store.get(ctx.runId)
  assert.equal(run?.step, "pr")
  assert.equal(run?.reviewFix, 1)
  // 免除した指摘は、再発の履歴にも数えない
  assert.deepEqual(run?.findingRounds, { [KEY]: [1] })
  const summary = readFileSync(join(ctx.worktree, ".harness", "run", "reviews", "round-2", "summary.md"), "utf8")
  assert.match(summary, /blocking_count: 0/)
  assert.match(summary, /## 免除した指摘[\s\S]*F-01[\s\S]*免除の理由: AC-2 は次の issue で見直すため/)
})

test("指摘の ID（観点:AC:ファイル）で免除できる。理由の「|」は表を壊さない", async () => {
  const ctx = setup([PASS], [reviewer(VIOLATION)])
  await reviewOnce(ctx)
  assert.equal(waive(ctx.deps, { run: ctx.runId, finding: KEY, reason: "仕様 A | B のどちらでもよい" }).kind, "done")
  assert.equal(readWaivers(ctx.worktree)[0]?.reason, "仕様 A | B のどちらでもよい")
  assert.match(readWaivers(ctx.worktree)[0]?.finding ?? "", /^F-01: /)
})

test("存在しない ID の指摘は免除できず、これまでに出た ID を示す（AC-3）", async () => {
  const ctx = setup([PASS], [reviewer(VIOLATION)])
  await reviewOnce(ctx)
  const unknown = waive(ctx.deps, { run: ctx.runId, finding: "spec:AC-9:src/none.ts", reason: "x" })
  assert.equal(unknown.kind, "error")
  assert.match(unknown.message, new RegExp(KEY))
  assert.equal(waive(ctx.deps, { run: ctx.runId, finding: "F-09", reason: "x" }).kind, "error")
  assert.deepEqual(readWaivers(ctx.worktree), [])
})

test("理由がない、同じ指摘を二重に免除する、run がないときはエラーにする", async () => {
  const ctx = setup([PASS], [reviewer(VIOLATION)])
  await reviewOnce(ctx)
  assert.match(waive(ctx.deps, { run: ctx.runId, finding: KEY, reason: " " }).message, /理由/)
  assert.equal(waive(ctx.deps, { run: ctx.runId, finding: KEY, reason: "対応不要" }).kind, "done")
  assert.match(waive(ctx.deps, { run: ctx.runId, finding: KEY, reason: "対応不要" }).message, /すでに免除/)
  assert.equal(waive(ctx.deps, { run: "issue-999", finding: KEY, reason: "x" }).kind, "error")
  assert.equal(readWaivers(ctx.worktree).length, 1)
})
