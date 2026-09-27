import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { advance } from "../machine/dev.ts"
import { childSessionsUsed } from "../steps/budget.ts"
import { formatStatus } from "../status.ts"
import { FAIL, PASS, setupLoop as setup } from "./loop-fixture.ts"

test("子セッションの数が上限に達した run は、次の子セッションを作らずに budget でエスカレーションする（AC-1）", async () => {
  // 毎回違うテストが失敗し、test-fix が 1 回ごとに子セッションを 1 つ作る
  const { store, calls, drive, runId } = setup([FAIL("[TC-01] a"), FAIL("[TC-02] b"), FAIL("[TC-03] c")], [], { budget: { maxChildSessionsPerIssue: 2 } })
  const result = await drive()
  assert.equal(result.kind, "escalated")
  assert.equal(calls.length, 2)
  const run = store.get(runId)
  assert.equal(run?.lastEscalation?.reason, "budget")
  assert.equal(run?.step, "test-fix")
  assert.equal(childSessionsUsed(store, runId), 2)
  const report = readFileSync(run!.lastEscalation!.report, "utf8")
  assert.match(report, /budget\.maxChildSessionsPerIssue（2 個）/)
  assert.match(report, /test-fix 3/)
})

test("ちょうど上限の数までは子セッションを作れる", async () => {
  const { store, calls, drive, runId } = setup([FAIL("[TC-01] a"), FAIL("[TC-02] b"), PASS], [], { budget: { maxChildSessionsPerIssue: 2 } })
  const result = await drive()
  assert.equal(result.kind, "continue")
  assert.equal(calls.length, 2)
  assert.equal(store.get(runId)?.step, "review")
  assert.equal(store.get(runId)?.status, "in_progress")
})

test("上限の 80% 以上を使ったら、工程が進むたびに警告を出す（AC-2）", async () => {
  const { deps, runId } = setup([FAIL("[TC-01] a"), FAIL("[TC-02] b"), PASS], [], { budget: { maxChildSessionsPerIssue: 2 } })
  const messages: string[] = []
  for (let i = 0; i < 5; i++) messages.push((await advance(deps, runId)).message)
  // 1 個目（上限 2 の 80% 未満）までは警告しない
  assert.ok(messages.slice(0, 3).every((m) => !/予算/.test(m)))
  // 2 個目（80% 以上）を作った後は、工程が進むたびに警告する
  assert.match(messages[3]!, /⚠ 予算: 子セッションを 2 \/ 2 個/)
  assert.match(messages[4]!, /⚠ 予算/)
})

test("harness_status に、run ごとの子セッションの数と、80% 以上を使った run の警告を出す（AC-2）", async () => {
  const { deps, store, runId } = setup([FAIL()], [], { budget: { maxChildSessionsPerIssue: 5 } })
  const text = formatStatus({ status: "ok", path: "/repo/harness.config.json", config: deps.config, warnings: [] }, store.list(), () => 4)
  assert.match(text, new RegExp(`\\| ${runId} \\|.*\\| 4 / 5 \\|`))
  assert.match(text, new RegExp(`予算の警告:\\n- ${runId}: 予算: 子セッションを 4 / 5 個`))
  const quiet = formatStatus({ status: "ok", path: "/repo/harness.config.json", config: deps.config, warnings: [] }, store.list(), () => 3)
  assert.doesNotMatch(quiet, /予算の警告/)
})

test("既存の子セッションに続きを送る（再開）ときは、新しい子セッションとして数えない（AC-3）", async () => {
  const { deps, store, calls, runId } = setup([FAIL(), PASS], ["throw"], { budget: { maxChildSessionsPerIssue: 1 } })
  await advance(deps, runId) // checks → test-fix
  await assert.rejects(advance(deps, runId), /強制終了/)
  assert.equal(childSessionsUsed(store, runId), 1)
  // 上限 1 に達していても、同じ子セッションで続きから再開できる
  const resumed = await advance(deps, runId)
  assert.equal(resumed.kind, "continue")
  assert.equal(calls.at(-1)?.sessionID, "ses_fix_1")
  assert.equal(childSessionsUsed(store, runId), 1)
  assert.equal(store.get(runId)?.step, "checks")
})
