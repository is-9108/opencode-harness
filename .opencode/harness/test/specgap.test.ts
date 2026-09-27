import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { advance, record } from "../machine/dev.ts"
import { parseReview } from "../steps/review.ts"
import { PASS, fixer, reviewer, setupLoop as setup } from "./loop-fixture.ts"

const GAP = "| F-02 | spec_gap | no | AC-3 | - | 空白だけの入力の扱いが決まっていない。解釈1: 空文字を返す / 解釈2: エラーにする |"
const GAP2 = "| F-03 | spec_gap | no | AC-4 | src/slug.ts:1 | 長さの上限が文字数かバイト数か決まっていない。解釈1: 文字数 / 解釈2: バイト数 |"
const VIOLATION = "| F-01 | spec_violation | yes | AC-2 | src/slug.ts:1 | 記号だけの入力で空文字を返していない |"

const review = (rows: string[]) =>
  `---\nstatus: done\nperspective: spec\n---\n## 指摘\n| ID | 分類 | blocking | AC | 根拠（ファイル:行） | 内容 |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`

// ---- 指摘の読み取り ----

test("曖昧な AC の ID と 2 つ以上の解釈がそろった spec_gap を、ユーザーに聞く指摘として読み取る", () => {
  const parsed = parseReview(review([GAP]))
  assert.deepEqual(parsed.problems, [])
  assert.equal(parsed.gaps.length, 1)
  assert.deepEqual(parsed.gaps[0]?.options, ["空文字を返す", "エラーにする"])
  assert.equal(parsed.blocking.length, 0)
})

test("根拠のない spec_gap（AC の ID がない、解釈が 1 つしかない）は、other として扱い、ユーザーに聞かない", () => {
  const noAc = "| F-05 | spec_gap | no | - | - | なんとなく曖昧。解釈1: A / 解釈2: B |"
  const oneOption = "| F-06 | spec_gap | no | AC-1 | - | 曖昧な気がする。解釈1: A |"
  const parsed = parseReview(review([noAc, oneOption]))
  assert.equal(parsed.gaps.length, 0)
  assert.deepEqual(parsed.downgraded.map((d) => d.finding.id), ["F-05", "F-06"])
  assert.match(parsed.downgraded[0]!.reason, /other/)
})

// ---- review の工程 ----

// checks → review まで進め、review の結果を返す
const reviewOnce = async (ctx: ReturnType<typeof setup>) => {
  await advance(ctx.deps, ctx.runId) // checks → review
  return advance(ctx.deps, ctx.runId)
}

test("spec_gap があれば、ループの回数を増やさずに need_user になり、解釈の選択肢を示す（AC-1）", async () => {
  const ctx = setup([PASS], [reviewer(GAP)])
  const result = await reviewOnce(ctx)
  assert.equal(result.kind, "need_user")
  assert.match(result.message, /AC-3/)
  assert.match(result.message, /1\. 空文字を返す/)
  assert.match(result.message, /2\. エラーにする/)
  assert.match(result.message, /gate: "spec_gap"/)
  const run = ctx.store.get(ctx.runId)
  assert.equal(run?.step, "spec-gap")
  assert.equal(run?.reviewFix, undefined)
  assert.equal(run?.autoFixUsed, undefined)
  // 答えるまでは、何度進めても同じことを聞く
  assert.equal((await advance(ctx.deps, ctx.runId)).kind, "need_user")
})

test("回答を 04-decisions.md に記録し、決まった解釈で差分の全体をもう一度レビューする。回答済みの点は再び聞かない（AC-2）", async () => {
  const ctx = setup([PASS], [reviewer(GAP), reviewer(GAP)])
  await reviewOnce(ctx)
  const recorded = record(ctx.deps, { run: ctx.runId, gate: "spec_gap", decision: "answered", feedback: "空文字を返す" })
  assert.equal(recorded.kind, "continue")

  const decisions = readFileSync(join(ctx.worktree, ".harness", "run", "04-decisions.md"), "utf8")
  assert.match(decisions, /D-1（AC-3/)
  assert.match(decisions, /決めた解釈: 空文字を返す/)
  // issue へのコメントは下書きまで
  assert.match(readFileSync(join(ctx.worktree, ".harness", "run", "issue-comment-draft.md"), "utf8"), /AC-3 の解釈[\s\S]*空文字を返す/)

  const next = await advance(ctx.deps, ctx.runId)
  assert.equal(next.kind, "continue")
  assert.equal(ctx.store.get(ctx.runId)?.step, "review")

  // 2 周目のレビュー: 決まった解釈を入力にし、差分の全体を見る
  const again = await advance(ctx.deps, ctx.runId)
  assert.equal(again.kind, "continue")
  const prompt = ctx.calls.at(-1)?.prompt ?? ""
  assert.match(prompt, /04-decisions\.md/)
  assert.doesNotMatch(prompt, /2 周目以降/)
  assert.match(readFileSync(join(ctx.worktree, ".harness", "run", "reviews", "round-2", "input.diff"), "utf8"), /slug\.test\.ts/)
  // 同じ spec_gap がまた出ても、回答済みなので聞かずに pr に進む
  assert.equal(ctx.store.get(ctx.runId)?.step, "pr")
  assert.match(readFileSync(join(ctx.worktree, ".harness", "run", "reviews", "round-2", "summary.md"), "utf8"), /回答済み/)
})

test("spec_gap と spec_violation が同時に出たら、先に spec_gap を聞き、その後で review-fix に進む（AC-3）", async () => {
  const ctx = setup([PASS], [reviewer(VIOLATION, GAP), fixer, reviewer()])
  const result = await reviewOnce(ctx)
  assert.equal(result.kind, "need_user")
  assert.equal(ctx.store.get(ctx.runId)?.reviewFix, undefined)

  record(ctx.deps, { run: ctx.runId, gate: "spec_gap", decision: "answered", feedback: "エラーにする" })
  const next = await advance(ctx.deps, ctx.runId)
  assert.equal(next.kind, "continue")
  const run = ctx.store.get(ctx.runId)
  assert.equal(run?.step, "review-fix")
  assert.equal(run?.reviewFix, 1)
  assert.equal(run?.pendingSpecGaps, undefined)

  // review-fix には、決まった解釈を渡す
  await advance(ctx.deps, ctx.runId)
  const fix = ctx.calls.find((c) => c.agent === "review-fixer")
  assert.match(fix?.prompt ?? "", /04-decisions\.md/)
  await ctx.drive(20, "pr")
  assert.equal(ctx.store.get(ctx.runId)?.step, "pr")
})

test("spec_gap が複数あれば 1 件ずつ聞き、すべて答えてから進む", async () => {
  const ctx = setup([PASS], [reviewer(GAP, GAP2)])
  const first = await reviewOnce(ctx)
  assert.match(first.message, /AC-3/)
  assert.match(first.message, /残り 2 件/)
  const second = record(ctx.deps, { run: ctx.runId, gate: "spec_gap", decision: "answered", feedback: "空文字を返す" })
  assert.equal(second.kind, "need_user")
  assert.match(second.message, /AC-4/)
  const done = record(ctx.deps, { run: ctx.runId, gate: "spec_gap", decision: "answered", feedback: "文字数" })
  assert.equal(done.kind, "continue")
  const decisions = readFileSync(join(ctx.worktree, ".harness", "run", "04-decisions.md"), "utf8")
  assert.match(decisions, /D-1（AC-3[\s\S]*D-2（AC-4/)
  assert.deepEqual(ctx.store.get(ctx.runId)?.answeredGaps, ["spec:AC-3:-", "spec:AC-4:src/slug.ts"])
})

test("回答が空、または回答を待っていないときの記録はエラーにする", async () => {
  const ctx = setup([PASS], [reviewer(GAP)])
  assert.equal(record(ctx.deps, { run: ctx.runId, gate: "spec_gap", decision: "answered", feedback: "x" }).kind, "error")
  await reviewOnce(ctx)
  const empty = record(ctx.deps, { run: ctx.runId, gate: "spec_gap", decision: "answered", feedback: " " })
  assert.equal(empty.kind, "error")
  assert.equal(existsSync(join(ctx.worktree, ".harness", "run", "04-decisions.md")), false)
  assert.equal(ctx.store.get(ctx.runId)?.step, "spec-gap")
})
