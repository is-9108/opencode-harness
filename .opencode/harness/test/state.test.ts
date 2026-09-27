import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore, startRun, runIdFor } from "../state.ts"

const tempRoot = () => mkdtempSync(join(tmpdir(), "harness-state-"))
const clock = (start = Date.parse("2026-09-27T00:00:00Z")) => {
  let t = start
  return () => new Date((t += 1000))
}

test("同じ issue で 2 回 start しても run は 1 つだけで、2 回目は既存の run を返す", () => {
  const store = createStore(tempRoot(), clock())
  const first = startRun(store, { kind: "dev", issue: 12 })
  const second = startRun(store, { kind: "dev", issue: 12 })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.deepEqual(second.run, first.run)
  assert.deepEqual(store.list().runs.map((r) => r.id), ["issue-12"])
})

test("新しい run は setup の工程から始まり、作成のイベントが記録される", () => {
  const root = tempRoot()
  const { run } = startRun(createStore(root, clock()), { kind: "dev", issue: 3 })
  assert.equal(run.id, "issue-3")
  assert.equal(run.status, "in_progress")
  assert.equal(run.step, "setup")
  const events = readFileSync(join(root, ".harness", "runs", "issue-3", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(events[0].type, "run.created")
})

test("保存すると更新時刻が進み、読み直すと同じ内容になる", () => {
  const store = createStore(tempRoot(), clock())
  const { run } = startRun(store, { kind: "dev", issue: 5 })
  const saved = store.save({ ...run, step: "plan" })
  assert.equal(store.get("issue-5")?.step, "plan")
  assert.ok(saved.updatedAt > run.updatedAt)
})

test("書き込みの途中で終了して一時ファイルだけが残っても、直前の state.json を読める", () => {
  const root = tempRoot()
  const store = createStore(root, clock())
  const { run } = startRun(store, { kind: "dev", issue: 8 })
  const dir = join(root, ".harness", "runs", "issue-8")
  writeFileSync(join(dir, "state.json.tmp-999-abc"), "{ \"id\": \"issue-8\", \"step\": ")
  assert.deepEqual(store.get("issue-8"), run)
  assert.deepEqual(store.list().runs.map((r) => r.id), ["issue-8"])
})

test("保存は一時ファイルを経由し、終わった後に一時ファイルを残さない", () => {
  const root = tempRoot()
  const store = createStore(root, clock())
  const { run } = startRun(store, { kind: "dev", issue: 9 })
  store.save({ ...run, step: "plan" })
  assert.deepEqual(readdirSync(join(root, ".harness", "runs", "issue-9")).sort(), ["events.jsonl", "state.json"])
})

test("壊れた state.json は一覧で broken として報告し、ほかの run は読める", () => {
  const root = tempRoot()
  const store = createStore(root, clock())
  startRun(store, { kind: "dev", issue: 1 })
  mkdirSync(join(root, ".harness", "runs", "issue-2"), { recursive: true })
  writeFileSync(join(root, ".harness", "runs", "issue-2", "state.json"), "not json")
  const { runs, broken } = store.list()
  assert.deepEqual(runs.map((r) => r.id), ["issue-1"])
  assert.deepEqual(broken.map((b) => b.id), ["issue-2"])
})

test("一覧は更新時刻の新しい順に並ぶ", () => {
  const store = createStore(tempRoot(), clock())
  const a = startRun(store, { kind: "dev", issue: 1 }).run
  startRun(store, { kind: "dev", issue: 2 })
  store.save({ ...a, step: "plan" })
  assert.deepEqual(store.list().runs.map((r) => r.id), ["issue-1", "issue-2"])
})

test("存在しない run は undefined、run がないディレクトリでは空の一覧を返す", () => {
  const store = createStore(tempRoot(), clock())
  assert.equal(store.get("issue-404"), undefined)
  assert.deepEqual(store.list(), { runs: [], broken: [] })
})

test("issue 番号が正の整数でなければエラーにする", () => {
  const store = createStore(tempRoot(), clock())
  for (const issue of [0, -1, 1.5, Number.NaN]) assert.throws(() => startRun(store, { kind: "dev", issue }), /issue/)
  assert.equal(runIdFor({ kind: "dev", issue: 42 }), "issue-42")
})
