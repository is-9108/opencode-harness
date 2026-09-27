import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { advance, record } from "../machine/dev.ts"
import { readLock } from "../testing/lock.ts"
import { readFrontmatter } from "../artifacts.ts"
import { FAIL, PASS, git, setupLoop, type Behave } from "./loop-fixture.ts"

const requestPath = (wt: string, c = 1) => join(wt, ".harness", "run", "change-requests", `test-${c}.md`)

// test-fixer が、テストのほうが仕様と合っていないと判断して、変更申請を書く（実装は変えない）
const requestChange =
  (opts: { ac?: boolean } = {}): Behave =>
  (wt, _call, k) => {
    mkdirSync(join(wt, ".harness", "run", "test-fix"), { recursive: true })
    writeFileSync(join(wt, ".harness", "run", "test-fix", `${k}.md`), `---\nstatus: done\n---\n## 原因\nTC-01 の期待値が AC-2 と逆\n\n## 修正\n実装は変えていない。テストの変更を申請した\n`)
    mkdirSync(join(wt, ".harness", "run", "change-requests"), { recursive: true })
    writeFileSync(
      requestPath(wt),
      [
        "---",
        "status: pending",
        "tests: src/slug.test.ts > [TC-01] a",
        ...(opts.ac === false ? [] : ["ac: AC-2"]),
        "---",
        "## 理由",
        "AC-2 では空文字を返すとあるが、TC-01 は例外を期待している",
        "",
        "## 変更内容",
        "TC-01 の期待値を空文字にする",
        "",
      ].join("\n"),
    )
    return "completed"
  }

// test-writer がテストを申請どおりに変える
const changeTest: Behave = (wt, call) => {
  assert.equal(call.agent, "test-writer")
  writeFileSync(join(wt, "src", "slug.test.ts"), "test('[TC-01] a', () => expect(slugify('')).toBe(''))\n")
  return "completed"
}

// checks の失敗 → test-fix（申請）まで進める
const toRequest = async (behaviors: (Behave | "throw")[], checks = [FAIL(), PASS]) => {
  const ctx = setupLoop(checks, behaviors)
  await advance(ctx.deps, ctx.runId) // checks → test-fix
  const result = await advance(ctx.deps, ctx.runId) // test-fix（申請）
  return { ...ctx, result }
}

test("test-fixer が変更申請を書いたら、test_change_request でエスカレーションし、申請の要約と判断の手順を示す（AC-1）", async () => {
  const { store, worktree, result, runId } = await toRequest([requestChange()])
  assert.equal(result.kind, "need_user")
  assert.match(result.message, /test_change_request/)
  assert.match(result.message, /\[TC-01\] a/)
  assert.match(result.message, /AC-2/)
  assert.match(result.message, /harness_record/)
  const run = store.get(runId)
  assert.equal(run?.status, "escalated")
  assert.equal(run?.mode, "human")
  assert.equal(run?.lastEscalation?.reason, "test_change_request")
  assert.equal(run?.pendingChangeRequest, requestPath(worktree))
})

test("申請を待っている run を advance すると、/fix ではなく申請への判断を求める", async () => {
  const { deps, runId } = await toRequest([requestChange()])
  const again = await advance(deps, runId)
  assert.equal(again.kind, "need_user")
  assert.match(again.message, /gate: "?test_change/)
})

test("申請が承認されたら、test-writer がテストを変え、ロックを更新して checks に戻る（AC-2）", async () => {
  const { deps, store, worktree, calls, runId } = await toRequest([requestChange(), changeTest])
  const before = readLock(worktree)
  const recorded = record(deps, { run: runId, gate: "test_change", decision: "approved" })
  assert.equal(recorded.kind, "continue")
  assert.equal(store.get(runId)?.step, "test-change")
  assert.equal(store.get(runId)?.status, "in_progress")

  const changed = await advance(deps, runId)
  assert.equal(changed.kind, "continue")
  assert.equal(calls.at(-1)?.agent, "test-writer")
  assert.ok((calls.at(-1)?.prompt ?? "").includes(requestPath(worktree)))
  const after = readLock(worktree)
  assert.notEqual(after?.commit, before?.commit)
  assert.notDeepEqual(after?.files, before?.files)
  assert.match(git(worktree, "log", "-1", "--format=%s"), /テストの変更申請/)
  assert.equal(readFrontmatter(readFileSync(requestPath(worktree), "utf8")).status, "approved")
  assert.equal(store.get(runId)?.step, "checks")
  assert.equal(store.get(runId)?.pendingChangeRequest, undefined)

  // 変えたテストはロックされ、以降の監査で守られる
  assert.equal((await advance(deps, runId)).kind, "continue")
  assert.equal(store.get(runId)?.step, "review")
})

test("申請が却下されたら、却下の理由を添えて test-fix に戻る（AC-3）", async () => {
  const { deps, store, worktree, calls, runId } = await toRequest([requestChange()])
  const recorded = record(deps, { run: runId, gate: "test_change", decision: "rejected", feedback: "TC-01 は AC-3 の例外の仕様どおり。実装を直すこと" })
  assert.equal(recorded.kind, "continue")
  const run = store.get(runId)
  assert.equal(run?.step, "test-fix")
  assert.equal(run?.status, "in_progress")
  assert.equal(run?.testFix, 2)
  assert.equal(readFrontmatter(readFileSync(requestPath(worktree), "utf8")).status, "rejected")

  await advance(deps, runId)
  assert.equal(calls.at(-1)?.agent, "test-fixer")
  assert.match(calls.at(-1)?.prompt ?? "", /却下/)
  assert.match(calls.at(-1)?.prompt ?? "", /AC-3 の例外の仕様どおり/)
})

test("frontmatter の tests と ac が YAML のリスト形式でも、申請として扱う（実機の LLM はリストで書くことがある）", async () => {
  const listStyle: Behave = (wt, call, k) => {
    requestChange()(wt, call, k)
    const p = requestPath(wt)
    writeFileSync(p, readFileSync(p, "utf8").replace("tests: src/slug.test.ts > [TC-01] a\nac: AC-2", "tests:\n  - src/slug.test.ts > [TC-01] a\nac:\n  - AC-2\n  - AC-3"))
    return "completed"
  }
  const { result } = await toRequest([listStyle])
  assert.equal(result.kind, "need_user")
  assert.match(result.message, /AC-2、AC-3/)
  assert.match(result.message, /\[TC-01\] a/)
})

test("根拠の AC がない申請は、申請として扱わず、test-fix の結果として checks に戻る（AC-4）", async () => {
  const { store, worktree, result, runId } = await toRequest([requestChange({ ac: false })])
  assert.equal(result.kind, "continue")
  assert.match(result.message, /根拠/)
  assert.equal(store.get(runId)?.step, "checks")
  assert.equal(store.get(runId)?.status, "in_progress")
  assert.equal(readFrontmatter(readFileSync(requestPath(worktree), "utf8")).status, "invalid")
})

test("却下で feedback が空ならエラーにし、申請を待っていない run への記録もエラーにする", async () => {
  const { deps, runId } = await toRequest([requestChange()])
  assert.equal(record(deps, { run: runId, gate: "test_change", decision: "rejected" }).kind, "error")

  const other = setupLoop([FAIL(), PASS])
  assert.equal(record(other.deps, { run: other.runId, gate: "test_change", decision: "approved" }).kind, "error")
})

test("test-writer がテスト以外のファイルを変えたら、commit せずにエラーにする", async () => {
  const touchImpl: Behave = (wt) => {
    writeFileSync(join(wt, "src", "slug.test.ts"), "test('[TC-01] a', () => {})\n")
    writeFileSync(join(wt, "src", "slug.ts"), "export const slugify = () => ''\n")
    return "completed"
  }
  const { deps, store, worktree, runId } = await toRequest([requestChange(), touchImpl])
  record(deps, { run: runId, gate: "test_change", decision: "approved" })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /src\/slug\.ts/)
  assert.doesNotMatch(git(worktree, "log", "-1", "--format=%s"), /テストの変更申請/)
  assert.equal(store.get(runId)?.step, "test-change")
  assert.ok(existsSync(requestPath(worktree)))
})
