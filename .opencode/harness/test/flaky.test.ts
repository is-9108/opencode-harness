import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advance, type StepDeps } from "../machine/dev.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import type { ShellResult } from "../exec.ts"
import { readFrontmatter } from "../artifacts.ts"

type Case = { name: string; message?: string }
const junit = (failed: Case[], passed: string[] = []) =>
  `<testsuites><testsuite name="s">${[
    ...failed.map((c) => `<testcase classname="src/a.test.ts" name="${c.name}"><failure type="AssertionError" message="${c.message ?? "expected 1 to be 2"}"/></testcase>`),
    ...passed.map((n) => `<testcase classname="src/a.test.ts" name="${n}"/>`),
  ].join("")}</testsuite></testsuites>`

// checks が失敗したら、test-fix のループに進む（#35）。advance した後の工程を返す
const stepAfter = async (deps: StepDeps, runId: string) => {
  await advance(deps, runId)
  return deps.store.get(runId)?.step
}

type Script = { code: number; stdout?: string; timedOut?: boolean; junit?: string }

// 偽のシェル。コマンドごとに、呼ばれた順に結果を返す（最後の結果は繰り返す）
const setup = (scripts: Record<string, Script[]>, opts: { flakyRetries?: number } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "harness-flaky-"))
  const worktree = join(root, "wt")
  mkdirSync(join(worktree, ".harness", "run"), { recursive: true })
  const store = createStore(root)
  const { run } = startRun(store, { kind: "dev", issue: 7 })
  store.save({ ...run, step: "checks", worktree, branch: "feat/7-x" })
  const { config } = validateConfig({
    models: {},
    checks: [
      { name: "lint", command: "npm run lint" },
      { name: "test", command: "npx vitest run", junit: ".harness/run/junit.xml" },
    ],
    tests: { globs: ["**/*.test.ts"], flakyRetries: opts.flakyRetries ?? 1 },
  })
  assert.ok(config)
  const calls: string[] = []
  const shell = async (command: string, o: { cwd: string }): Promise<ShellResult> => {
    const n = calls.filter((c) => c === command).length
    calls.push(command)
    const list = scripts[command] ?? [{ code: 0 }]
    const s = list[Math.min(n, list.length - 1)]!
    if (s.junit !== undefined) writeFileSync(join(o.cwd, ".harness", "run", "junit.xml"), s.junit)
    return { code: s.code, stdout: s.stdout ?? "", stderr: "", timedOut: s.timedOut ?? false, durationMs: 10 }
  }
  const child = async (): Promise<never> => {
    throw new Error("子セッションは呼ばれないはず")
  }
  const deps: StepDeps = { root, config, store, exec: async () => ({ code: 0, stdout: "", stderr: "" }), shell, child }
  const record = (n: number) => readFileSync(join(worktree, ".harness", "run", "checks", `run-${n}.md`), "utf8")
  // 次の checks を実行できるように、エスカレーションを解いて checks に戻す
  const again = () => store.save({ ...store.get(run.id)!, status: "in_progress", step: "checks" })
  return { deps, store, calls, record, again, runId: run.id }
}

const PASS = { code: 0, junit: junit([], ["[TC-01] a", "[TC-02] b"]) }
const FAIL_TC2 = (message?: string) => ({ code: 1, junit: junit([{ name: "[TC-02] b", message }], ["[TC-01] a"]) })

test("1 回目に失敗し、再実行で通るテストは flaky として記録し、合格にする（AC-1）", async () => {
  const { deps, store, calls, record, runId } = setup({ "npx vitest run": [FAIL_TC2(), PASS] })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  assert.deepEqual(calls, ["npm run lint", "npx vitest run", "npx vitest run"])
  assert.equal(store.get(runId)?.step, "review")
  const text = record(1)
  assert.match(text, /status: passed/)
  assert.match(text, /## flaky[\s\S]*\[TC-02\] b/)
  const events = readFileSync(join(deps.root, ".harness", "runs", runId, "events.jsonl"), "utf8")
  assert.match(events, /"flaky":\["src\/a.test.ts > \[TC-02\] b"\]/)
})

test("一部のテストだけが再実行で通ったら、通ったものは flaky、すべての実行で失敗したものは本当の失敗として扱う", async () => {
  const { deps, record, runId } = setup({ "npx vitest run": [{ code: 1, junit: junit([{ name: "[TC-02] b" }, { name: "[TC-01] a" }]) }, FAIL_TC2()] })
  // TC-01 は 1 回目だけ失敗、TC-02 は両方で失敗 → TC-02 だけが本当の失敗
  assert.equal(await stepAfter(deps, runId), "test-fix")
  const text = record(1)
  // 失敗したテストの表には本当の失敗だけ、flaky の一覧には 1 回目だけ失敗したテストを載せる
  assert.match(text, /^\| \[TC-02\] b \|/m)
  assert.doesNotMatch(text, /^\| \[TC-01\] a \|/m)
  assert.match(text, /## flaky[\s\S]*- src\/a\.test\.ts > \[TC-01\] a/)
})

test("再実行でも失敗するテストは不合格にし、失敗の指紋を記録する（AC-2）", async () => {
  const { deps, store, record, runId } = setup({ "npx vitest run": [FAIL_TC2()] })
  assert.equal(await stepAfter(deps, runId), "test-fix")
  const fm = readFrontmatter(record(1))
  assert.match(fm.fingerprint ?? "", /^[0-9a-f]{16}$/)
  assert.deepEqual(store.get(runId)?.fingerprints, [fm.fingerprint])
})

test("flakyRetries が 0 なら再実行しない", async () => {
  const { deps, calls, runId } = setup({ "npx vitest run": [FAIL_TC2(), PASS] }, { flakyRetries: 0 })
  assert.equal(await stepAfter(deps, runId), "test-fix")
  assert.deepEqual(calls, ["npm run lint", "npx vitest run"])
})

test("JUnit のないチェックは再実行しない", async () => {
  const { deps, calls, runId } = setup({ "npm run lint": [{ code: 1, stdout: "src/a.ts\n  3:7  error  'x' is never used  no-unused-vars\n" }, { code: 0 }], "npx vitest run": [PASS] })
  assert.equal(await stepAfter(deps, runId), "test-fix")
  assert.equal(calls.filter((c) => c === "npm run lint").length, 1)
})

test("行番号や一時パスだけが違う同じ失敗は、同じ指紋になる（AC-3）", async () => {
  const msg = (line: number, dir: string) => `expected 1 to be 2 at C:\\Users\\me\\AppData\\Local\\Temp\\${dir}\\a.test.ts:${line}:5`
  const { deps, store, again, runId } = setup({
    "npx vitest run": [FAIL_TC2(msg(10, "vitest-abc")), FAIL_TC2(msg(10, "vitest-abc")), FAIL_TC2(msg(12, "vitest-xyz"))],
  })
  await advance(deps, runId)
  again()
  await advance(deps, runId)
  const [first, second] = store.get(runId)?.fingerprints ?? []
  assert.ok(first)
  assert.equal(first, second)
})

test("失敗したテストの組み合わせが違えば、違う指紋になる（AC-4）", async () => {
  const { deps, store, again, runId } = setup({
    "npx vitest run": [FAIL_TC2(), FAIL_TC2(), { code: 1, junit: junit([{ name: "[TC-01] a" }, { name: "[TC-02] b" }]) }],
  })
  await advance(deps, runId)
  again()
  await advance(deps, runId)
  const [first, second] = store.get(runId)?.fingerprints ?? []
  assert.ok(first && second)
  assert.notEqual(first, second)
})

test("JUnit が出ない失敗（ビルドエラーなど）も、エラーの行から指紋を作る", async () => {
  const { deps, store, calls, runId } = setup({ "npx vitest run": [{ code: 1, stdout: "Error: Transform failed with 1 error:\nsrc/a.ts:3:10: ERROR: Unexpected \"}\"\n" }] })
  assert.equal(await stepAfter(deps, runId), "test-fix")
  assert.equal(calls.filter((c) => c === "npx vitest run").length, 1)
  assert.match(store.get(runId)?.fingerprints?.[0] ?? "", /^[0-9a-f]{16}$/)
})
