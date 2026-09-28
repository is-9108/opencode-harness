import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { advance } from "../machine/dev.ts"
import { startFix } from "../steps/fix.ts"
import { waive } from "../steps/waiver.ts"
import { fixEditDenial, isAllowedFixCommand, isTestPath } from "../fix-guard.ts"
import { FAIL, PASS, fixIt, fixer, git, reviewer, setupLoop as setup } from "./loop-fixture.ts"

const VIOLATION = "| F-01 | spec_violation | yes | AC-2 | src/slug.ts:1 | 記号だけの入力で空文字を返していない |"

// harness-fix がコードを直し、修正の記録を書く
const fixByHand = (worktree: string, e: number, change = true) => {
  if (change) writeFileSync(join(worktree, "src", "slug.ts"), `export const slugify = (s: string) => s.trim() // /fix ${e}\n`)
  writeFileSync(join(worktree, ".harness", "run", `fix-${e}.md`), `---\nstatus: done\n---\n## 方針\n境界値の扱いを直す\n\n## 修正\n${change ? "src/slug.ts の前後の空白を取り除く" : "なし（指摘を免除した）"}\n`)
}

// test-fix の上限（1 回）でエスカレーションした run
const escalatedInTestFix = async (checks = [FAIL("[TC-01] a"), FAIL("[TC-02] b"), PASS], behaviors = [fixIt, reviewer()]) => {
  const ctx = setup(checks, behaviors, { loops: { testFix: 1 } })
  assert.equal((await ctx.drive()).kind, "escalated")
  return ctx
}

test("escalated の run で /fix を始めると、報告の要約と方針の選択肢を示す（AC-1）", async () => {
  const ctx = await escalatedInTestFix()
  const result = startFix(ctx.deps, 12)
  assert.equal(result.kind, "need_user")
  assert.match(result.message, /理由: loop_exhausted/)
  assert.match(result.message, /test-fix を 1 回/) // 報告の本文
  assert.match(result.message, /1\. 直す/)
  assert.match(result.message, /テストの変更を申請する/)
  assert.doesNotMatch(result.message, /指摘を免除して進める/) // checks の失敗には、指摘の免除は出さない
  assert.match(result.message, /今は止める/)
  assert.match(result.message, /fix-1\.md/)
  assert.match(result.message, /checks[\\/]run-2\.md/) // 失敗ログ
})

test("escalated でない run や、run がない issue では、何もせずに理由を示す（AC-5）", async () => {
  const ctx = setup([FAIL()])
  const before = readFileSync(join(ctx.deps.root, ".harness", "runs", ctx.runId, "state.json"), "utf8")
  const result = startFix(ctx.deps, 12)
  assert.equal(result.kind, "error")
  assert.match(result.message, /エスカレーションされていない/)
  assert.match(result.message, /\/dev 12/)
  assert.equal(readFileSync(join(ctx.deps.root, ".harness", "runs", ctx.runId, "state.json"), "utf8"), before)
  assert.match(startFix(ctx.deps, 99).message, /issue #99 の run はありません/)
})

test("修正の記録ができたら、commit して checks → review（1 周）に進み、blocking がなければ pr に進む。testFix は 0 に戻す（AC-2）", async () => {
  const ctx = await escalatedInTestFix()
  startFix(ctx.deps, 12)
  // 記録がまだなければ再開しない
  const waiting = await advance(ctx.deps, ctx.runId)
  assert.equal(waiting.kind, "escalated")
  assert.match(waiting.message, /fix-1\.md/)

  fixByHand(ctx.worktree, 1)
  const resumed = await advance(ctx.deps, ctx.runId)
  assert.equal(resumed.kind, "continue")
  let run = ctx.store.get(ctx.runId)
  assert.equal(run?.status, "in_progress")
  assert.equal(run?.step, "checks")
  assert.equal(run?.testFix, 0)
  assert.equal(run?.mode, "human")
  assert.match(git(ctx.worktree, "log", "-1", "--format=%s"), /\/fix/)

  await ctx.drive(20, "pr")
  run = ctx.store.get(ctx.runId)
  assert.equal(run?.step, "pr")
  assert.equal(run?.reviewRounds, 1)
})

test("review-fix の上限でエスカレーションした run を /fix で直しても、human モードのレビューで blocking が残れば、review-fix を実行せずに再びエスカレーションする（AC-3）", async () => {
  const ctx = setup([PASS], [reviewer(VIOLATION), fixer, reviewer(VIOLATION), reviewer(VIOLATION)], { loops: { reviewFix: 1 } })
  assert.equal((await ctx.drive(20, "pr")).kind, "escalated")
  // レビューでのエスカレーションには、指摘の免除も選択肢に出す
  assert.match(startFix(ctx.deps, 12).message, /指摘を免除して進める/)

  fixByHand(ctx.worktree, 1)
  const result = await ctx.drive(20, "pr")
  assert.equal(result.kind, "escalated")
  const run = ctx.store.get(ctx.runId)
  assert.equal(run?.lastEscalation?.number, 2)
  assert.match(result.message, /human モード/)
  assert.equal(ctx.calls.filter((c) => c.agent === "review-fixer").length, 1)
  // 修正の後のレビューは、前回のレビューからの差分を見る
  assert.match(ctx.calls.at(-1)?.prompt ?? "", /2 周目以降/)
})

test("/fix で指摘を免除すれば、コードを変えずに再開して pr に進める", async () => {
  const ctx = setup([PASS], [reviewer(VIOLATION), fixer, reviewer(VIOLATION), reviewer(VIOLATION)], { loops: { reviewFix: 1 } })
  await ctx.drive(20, "pr")
  assert.equal(waive(ctx.deps, { run: ctx.runId, finding: "F-01", reason: "AC-2 は次の issue で扱う" }).kind, "done")
  fixByHand(ctx.worktree, 1, false)
  await ctx.drive(20, "pr")
  assert.equal(ctx.store.get(ctx.runId)?.step, "pr")
})

test("harness-fix がテストファイルを変えていたら、元に戻して再開しない（テストのロックの監査）", async () => {
  const ctx = await escalatedInTestFix()
  fixByHand(ctx.worktree, 1)
  writeFileSync(join(ctx.worktree, "src", "slug.test.ts"), "test('[TC-01] a', () => {}) // 捻じ曲げ\n")
  const result = await advance(ctx.deps, ctx.runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /元に戻しました/)
  assert.equal(readFileSync(join(ctx.worktree, "src", "slug.test.ts"), "utf8").replace(/\r\n/g, "\n"), "test('[TC-01] a')\n")
  assert.equal(ctx.store.get(ctx.runId)?.status, "escalated")
  assert.doesNotMatch(git(ctx.worktree, "log", "-1", "--format=%s"), /\/fix/)
})

test("/fix でテストの変更申請を書いたら、再開の前に申請の判断を求める", async () => {
  const ctx = await escalatedInTestFix()
  fixByHand(ctx.worktree, 1, false)
  mkdirSync(join(ctx.worktree, ".harness", "run", "change-requests"), { recursive: true })
  writeFileSync(join(ctx.worktree, ".harness", "run", "change-requests", "test-1.md"), "---\nstatus: pending\ntests: src/slug.test.ts > [TC-02] b\nac: AC-3\n---\n## 理由\nAC-3 と逆\n\n## 変更内容\n期待値を直す\n")
  const result = await advance(ctx.deps, ctx.runId)
  assert.equal(result.kind, "need_user")
  assert.match(result.message, /gate: "test_change"/)
  const run = ctx.store.get(ctx.runId)
  assert.equal(run?.lastEscalation?.reason, "test_change_request")
  // /fix をやり直しても、判断を先に求める
  assert.match(startFix(ctx.deps, 12).message, /テストの変更申請への判断を待っています/)
})

// ---- harness-fix の編集とコマンドの制限（プラグインのフックが使う） ----

test("harness-fix は、テストファイル・ハーネスの成果物・秘密情報を編集できない（AC-4）", async () => {
  const { deps } = setup([PASS])
  const wt = "C:\\work\\repo.worktrees\\issue-12"
  const deny = (tool: string, args: Record<string, unknown>) => fixEditDenial(deps.config, tool, args)
  assert.match(deny("edit", { filePath: `${wt}\\src\\slug.test.ts` }) ?? "", /テストファイル/)
  assert.match(deny("write", { filePath: "/w/repo.worktrees/issue-12/src/deep/a.test.ts" }) ?? "", /テストファイル/)
  assert.match(deny("apply_patch", { patchText: "*** Begin Patch\n*** Update File: src/slug.test.ts\n@@\n-a\n+b\n*** End Patch" }) ?? "", /テストファイル/)
  assert.match(deny("edit", { filePath: "/w/repo.worktrees/issue-12/.harness/run/01-plan.md" }) ?? "", /成果物/)
  assert.match(deny("edit", { filePath: "/w/repo/.env" }) ?? "", /秘密情報/)
  assert.equal(deny("edit", { filePath: `${wt}\\src\\slug.ts` }), undefined)
  assert.equal(deny("write", { filePath: "/w/repo.worktrees/issue-12/.harness/run/fix-2.md" }), undefined)
  assert.equal(deny("write", { filePath: "/w/repo.worktrees/issue-12/.harness/run/change-requests/test-1.md" }), undefined)
  assert.equal(deny("read", { filePath: "/w/repo.worktrees/issue-12/src/slug.test.ts" }), undefined)
  assert.equal(isTestPath("src/slug.ts", ["**/*.test.ts"]), false)
})

test("harness-fix が確認なしで実行できるのは、checks のコマンドと git の読み取りだけ", () => {
  const { deps } = setup([PASS])
  const ok = (c: string) => isAllowedFixCommand(deps.config, c)
  assert.equal(ok("npx vitest run"), true)
  assert.equal(ok("cd /w/repo.worktrees/issue-12 && npx vitest run"), true)
  assert.equal(ok("git -C /w/repo.worktrees/issue-12 diff main...HEAD"), true)
  assert.equal(ok("git status"), true)
  assert.equal(ok("cd /tmp && npx vitest run"), false)
  assert.equal(ok("npx vitest run; rm -rf src"), false)
  assert.equal(ok("git status && git commit -m x"), false)
  assert.equal(ok("rm -rf src"), false)
})
