import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advance, type StepDeps } from "../machine/dev.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import type { ShellResult } from "../exec.ts"

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

const PASSING_JUNIT = `<testsuites><testsuite name="s">
  <testcase classname="src/slug.test.ts" name="[TC-01] a"/>
  <testcase classname="src/slug.test.ts" name="[TC-02] b"/>
</testsuite></testsuites>`

type Script = { code: number; stdout?: string; stderr?: string; timedOut?: boolean; junit?: string }

// 偽のシェル。コマンドごとに結果を決め、JUnit を指定されていれば書き出す
const setup = (scripts: Record<string, Script>) => {
  const root = mkdtempSync(join(tmpdir(), "harness-checks-"))
  const worktree = join(root, "wt")
  mkdirSync(join(worktree, ".harness", "run"), { recursive: true })
  const store = createStore(root)
  const { run } = startRun(store, { kind: "dev", issue: 7 })
  store.save({ ...run, step: "checks", worktree, branch: "feat/7-x" })
  const { config } = validateConfig({
    models: {},
    checks: [
      { name: "lint", command: "npm run lint" },
      { name: "typecheck", command: "npx tsc --noEmit", timeoutSec: 5 },
      { name: "test", command: "npx vitest run", junit: ".harness/run/junit.xml" },
    ],
    tests: { globs: ["**/*.test.ts"] },
  })
  assert.ok(config)
  const calls: string[] = []
  const shell = async (command: string, o: { cwd: string; timeoutSec: number }): Promise<ShellResult> => {
    calls.push(command)
    const s = scripts[command] ?? { code: 0 }
    if (s.junit !== undefined) writeFileSync(join(o.cwd, ".harness", "run", "junit.xml"), s.junit)
    return { code: s.code, stdout: s.stdout ?? "", stderr: s.stderr ?? "", timedOut: s.timedOut ?? false, durationMs: 1200 }
  }
  const child = async (): Promise<never> => {
    throw new Error("checks では子セッションは呼ばれないはず")
  }
  const deps: StepDeps = { root, config, store, exec: async () => ({ code: 0, stdout: "", stderr: "" }), shell, child }
  const record = (n: number) => join(worktree, ".harness", "run", "checks", `run-${n}.md`)
  return { deps, store, calls, record, runId: run.id, worktree }
}

test("すべてのチェックが通れば、結果を checks/run-1.md に保存して review に進む", async () => {
  const { deps, store, calls, record, runId } = setup({ "npx vitest run": { code: 0, junit: PASSING_JUNIT } })
  const result = await advance(deps, runId)

  assert.equal(result.kind, "continue")
  assert.deepEqual(calls, ["npm run lint", "npx tsc --noEmit", "npx vitest run"])
  const text = readFileSync(record(1), "utf8")
  assert.match(text, /status: passed/)
  assert.match(text, /\| lint \| 成功/)
  assert.match(text, /\| test \| 成功.*2 件/)
  const run = store.get(runId)
  assert.equal(run?.step, "review")
  assert.equal(run?.checksRuns, 1)
})

test("lint だけが失敗しても、残りのチェックも実行して全結果を記録し、escalated になる", async () => {
  const { deps, store, calls, record, runId } = setup({
    "npm run lint": { code: 1, stdout: "src/slug.ts\n  3:7  error  'x' is assigned a value but never used  no-unused-vars\n" },
    "npx vitest run": { code: 0, junit: PASSING_JUNIT },
  })
  const result = await advance(deps, runId)

  assert.equal(result.kind, "escalated")
  assert.match(result.message, /lint/)
  assert.deepEqual(calls, ["npm run lint", "npx tsc --noEmit", "npx vitest run"])
  const text = readFileSync(record(1), "utf8")
  assert.match(text, /status: failed/)
  assert.match(text, /\| lint \| 失敗/)
  assert.match(text, /\| typecheck \| 成功/)
  assert.match(text, /no-unused-vars/)
  const run = store.get(runId)
  assert.equal(run?.status, "escalated")
  assert.equal(run?.step, "checks")
  // エスカレーションの報告を書く（#33）
  assert.equal(run?.lastEscalation?.reason, "loop_exhausted")
  assert.match(readFileSync(run?.lastEscalation?.report ?? "", "utf8"), /lint/)
})

test("タイムアウトしたチェックは失敗として記録する", async () => {
  const { deps, record, runId } = setup({ "npx tsc --noEmit": { code: 1, timedOut: true }, "npx vitest run": { code: 0, junit: PASSING_JUNIT } })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "escalated")
  assert.match(readFileSync(record(1), "utf8"), /\| typecheck \| 失敗（タイムアウト: 5 秒）/)
})

test("テストの失敗は、JUnit から失敗したテストの名前と理由を記録する", async () => {
  const { deps, record, runId } = setup({ "npx vitest run": { code: 1, junit: fixture("vitest-mixed.junit.xml") } })
  await advance(deps, runId)
  const text = readFileSync(record(1), "utf8")
  assert.match(text, /\[TC-01\] 空白をハイフンにする.*expected 'a b' to be 'a-b'/)
  assert.match(text, /src\/broken-import\.test\.ts.*Cannot find module/)
})

test("JUnit が出力されなかったら、そのことを記録する（成否は終了コードで決める）", async () => {
  const { deps, store, record, runId } = setup({})
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  assert.match(readFileSync(record(1), "utf8"), /JUnit.*出力されていません/)
  assert.equal(store.get(runId)?.step, "review")
})

test("前回の JUnit が残っていても、それを今回の結果として読まない", async () => {
  const { deps, worktree, record, runId } = setup({})
  writeFileSync(join(worktree, ".harness", "run", "junit.xml"), fixture("vitest-mixed.junit.xml"))
  await advance(deps, runId)
  assert.doesNotMatch(readFileSync(record(1), "utf8"), /TC-01/)
  assert.equal(existsSync(record(2)), false)
})
