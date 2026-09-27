import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advance, type StepDeps } from "../machine/dev.ts"
import { recordBaseline } from "../steps/baseline.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import type { ShellResult } from "../exec.ts"

const junit = (cases: { name: string; failed?: boolean }[]) =>
  `<testsuites><testsuite name="s">${cases
    .map((c) => (c.failed ? `<testcase classname="src/a.test.ts" name="${c.name}"><failure type="AssertionError" message="expected 1 to be 2"/></testcase>` : `<testcase classname="src/a.test.ts" name="${c.name}"/>`))
    .join("")}</testsuite></testsuites>`

type Script = { code: number; stdout?: string; timedOut?: boolean; junit?: string }

// 偽のシェル。scripts を差し替えると、ベースラインのときと checks のときで結果を変えられる
const setup = (initial: Record<string, Script>) => {
  const root = mkdtempSync(join(tmpdir(), "harness-baseline-"))
  const worktree = join(root, "wt")
  mkdirSync(join(worktree, ".harness", "run"), { recursive: true })
  const store = createStore(root)
  const { run } = startRun(store, { kind: "dev", issue: 7 })
  store.save({ ...run, step: "checks", worktree, branch: "feat/7-x" })
  const { config } = validateConfig({
    models: {},
    checks: [
      { name: "typecheck", command: "npx tsc --noEmit" },
      { name: "test", command: "npx vitest run", junit: ".harness/run/junit.xml" },
    ],
    tests: { globs: ["**/*.test.ts"] },
  })
  assert.ok(config)
  const state = { scripts: initial }
  const calls: string[] = []
  const shell = async (command: string, o: { cwd: string }): Promise<ShellResult> => {
    calls.push(command)
    const s = state.scripts[command] ?? { code: 0 }
    if (s.junit !== undefined) writeFileSync(join(o.cwd, ".harness", "run", "junit.xml"), s.junit)
    return { code: s.code, stdout: s.stdout ?? "", stderr: "", timedOut: s.timedOut ?? false, durationMs: 10 }
  }
  const child = async (): Promise<never> => {
    throw new Error("子セッションは呼ばれないはず")
  }
  const deps: StepDeps = { root, config, store, exec: async () => ({ code: 0, stdout: "", stderr: "" }), shell, child }
  const runDir = join(worktree, ".harness", "run")
  return { deps, store, state, calls, worktree, runDir, runId: run.id }
}

const OLD_FAIL = "[legacy] 既存の壊れたテスト"
const passingTests = junit([{ name: "[TC-01] a" }, { name: "[TC-02] b" }])

test("ベースラインで checks をすべて実行し、失敗がなければ空のベースラインを記録する（AC-1）", async () => {
  const { deps, calls, worktree, runDir } = setup({ "npx vitest run": { code: 0, junit: passingTests } })
  await recordBaseline(deps, worktree)
  assert.deepEqual(calls, ["npx tsc --noEmit", "npx vitest run"])
  const md = readFileSync(join(runDir, "00-baseline.md"), "utf8")
  assert.match(md, /failures: 0/)
  assert.ok(existsSync(join(runDir, "baseline.json")))
})

test("ベースラインが空なら、checks の判定は今までどおり（失敗すれば escalated）（AC-1）", async () => {
  const { deps, state, worktree, runId } = setup({ "npx vitest run": { code: 0, junit: passingTests } })
  await recordBaseline(deps, worktree)
  state.scripts = { "npx vitest run": { code: 1, junit: junit([{ name: "[TC-01] a", failed: true }]) } }
  assert.equal((await advance(deps, runId)).kind, "escalated")
})

test("ベースラインでもともと失敗しているテストは除外し、ほかがすべて通れば合格にする（AC-2）", async () => {
  const { deps, store, state, worktree, runDir, runId } = setup({ "npx vitest run": { code: 1, junit: junit([{ name: OLD_FAIL, failed: true }]) } })
  await recordBaseline(deps, worktree)
  assert.match(readFileSync(join(runDir, "00-baseline.md"), "utf8"), /既存の壊れたテスト/)

  state.scripts = { "npx vitest run": { code: 1, junit: junit([{ name: OLD_FAIL, failed: true }, { name: "[TC-01] a" }]) } }
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  assert.equal(store.get(runId)?.step, "review")
  const record = readFileSync(join(runDir, "checks", "run-1.md"), "utf8")
  assert.match(record, /status: passed/)
  assert.match(record, /ベースライン.*除外/)
  assert.match(record, /既存の壊れたテスト/)
})

test("ベースラインにないテストが失敗したら、不合格にする（AC-4）", async () => {
  const { deps, state, worktree, runId } = setup({ "npx vitest run": { code: 1, junit: junit([{ name: OLD_FAIL, failed: true }]) } })
  await recordBaseline(deps, worktree)
  state.scripts = { "npx vitest run": { code: 1, junit: junit([{ name: OLD_FAIL, failed: true }, { name: "[TC-01] a", failed: true }]) } }
  const result = await advance(deps, runId)
  assert.equal(result.kind, "escalated")
  assert.match(result.message, /test/)
})

test("ベースラインで失敗していたテストが通るようになったら、合格のまま「解消した」と記録する（AC-3）", async () => {
  const { deps, state, worktree, runDir, runId } = setup({ "npx vitest run": { code: 1, junit: junit([{ name: OLD_FAIL, failed: true }]) } })
  await recordBaseline(deps, worktree)
  state.scripts = { "npx vitest run": { code: 0, junit: junit([{ name: OLD_FAIL }, { name: "[TC-01] a" }]) } }
  assert.equal((await advance(deps, runId)).kind, "continue")
  const record = readFileSync(join(runDir, "checks", "run-1.md"), "utf8")
  assert.match(record, /解消/)
  assert.match(record, /既存の壊れたテスト/)
  // PR 本文の「ハーネスの記録」で使うため、イベントにも残す
  const events = readFileSync(join(deps.root, ".harness", "runs", runId, "events.jsonl"), "utf8")
  assert.match(events, /"resolved":\["src\/a.test.ts > \[legacy\] 既存の壊れたテスト"\]/)
})

test("JUnit のないチェックは、error の行を行番号を伏せて比べ、ベースラインと同じエラーだけなら除外する", async () => {
  const tscOld = "src/old.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n"
  const { deps, state, worktree, runId } = setup({ "npx tsc --noEmit": { code: 2, stdout: tscOld }, "npx vitest run": { code: 0, junit: passingTests } })
  await recordBaseline(deps, worktree)
  // 同じエラーが、上に行が増えて 10 行目に移った
  state.scripts = { "npx tsc --noEmit": { code: 2, stdout: tscOld.replace("(3,5)", "(10,5)") }, "npx vitest run": { code: 0, junit: passingTests } }
  assert.equal((await advance(deps, runId)).kind, "continue")
})

test("JUnit のないチェックで、ベースラインにないエラーの行が 1 つでもあれば不合格にする", async () => {
  const tscOld = "src/old.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n"
  const { deps, state, worktree, runId } = setup({ "npx tsc --noEmit": { code: 2, stdout: tscOld }, "npx vitest run": { code: 0, junit: passingTests } })
  await recordBaseline(deps, worktree)
  state.scripts = {
    "npx tsc --noEmit": { code: 2, stdout: tscOld + "src/new.ts(1,1): error TS2304: Cannot find name 'foo'.\n" },
    "npx vitest run": { code: 0, junit: passingTests },
  }
  assert.equal((await advance(deps, runId)).kind, "escalated")
})

test("ベースラインで失敗していても、比べる手がかり（error の行）がなければ除外しない", async () => {
  const { deps, state, worktree, runId } = setup({ "npx tsc --noEmit": { code: 1, stdout: "something went wrong\n" }, "npx vitest run": { code: 0, junit: passingTests } })
  await recordBaseline(deps, worktree)
  state.scripts = { "npx tsc --noEmit": { code: 1, stdout: "something went wrong\n" }, "npx vitest run": { code: 0, junit: passingTests } }
  assert.equal((await advance(deps, runId)).kind, "escalated")
})

test("タイムアウトは、ベースラインで失敗していても除外しない", async () => {
  const { deps, state, worktree, runId } = setup({ "npx vitest run": { code: 1, junit: junit([{ name: OLD_FAIL, failed: true }]) } })
  await recordBaseline(deps, worktree)
  state.scripts = { "npx vitest run": { code: 1, timedOut: true, junit: junit([{ name: OLD_FAIL, failed: true }]) } }
  assert.equal((await advance(deps, runId)).kind, "escalated")
})
