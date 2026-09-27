import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advance, type StepDeps } from "../machine/dev.ts"
import { evaluateRed } from "../steps/red.ts"
import { parseJUnit } from "../testing/junit.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import { realExec, type ShellResult } from "../exec.ts"
import type { ChildResult, RunChildOptions } from "../session.ts"

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
const tcs = (...ids: string[]) => ids.map((id) => ({ id, ac: "AC-1", kind: "正常系", content: "..." }))

// ---- evaluateRed（判定の規則） ----

test("計画のケースがすべてあり、アサーションか未実装の例外で失敗し、既存のテストが通っていれば合格", () => {
  const verdict = evaluateRed(tcs("TC-01", "TC-02"), parseJUnit(fixture("vitest-red.junit.xml")))
  assert.deepEqual(verdict.problems, [])
  assert.equal(verdict.ok, true)
})

test("import エラー・構文エラーで読み込めないテストファイルがあれば不合格にし、理由を示す", () => {
  const verdict = evaluateRed(tcs("TC-01", "TC-02", "TC-03", "TC-04"), parseJUnit(fixture("vitest-mixed.junit.xml")))
  assert.equal(verdict.ok, false)
  const text = verdict.problems.join("\n")
  assert.match(text, /src\/broken-import\.test\.ts.*Cannot find module/)
  assert.match(text, /src\/syntax\.test\.ts/)
  assert.match(text, /TC-03.*見つかりません/)
})

test("存在しない関数を呼んだ TypeError など、アサーション以外の理由の失敗は不合格にする", () => {
  const verdict = evaluateRed(tcs("TC-05"), parseJUnit(fixture("vitest-mixed.junit.xml")))
  assert.match(verdict.problems.join("\n"), /TC-05.*TypeError/)
})

test("新しいテストが最初から通っていれば、ロジックが書かれているとして不合格にする", () => {
  const xml = `<testsuites><testsuite name="s"><testcase classname="a.test.ts" name="[TC-01] x"/></testsuite></testsuites>`
  const verdict = evaluateRed(tcs("TC-01"), parseJUnit(xml))
  assert.match(verdict.problems.join("\n"), /TC-01.*通って/)
})

test("既存のテストが壊れていれば不合格にする。計画にない TC の ID も指摘する", () => {
  const xml = `<testsuites><testsuite name="s">
    <testcase classname="a.test.ts" name="[TC-01] x"><failure message="not implemented" type="Error"/></testcase>
    <testcase classname="old.test.ts" name="古いテスト"><failure message="expected 1 to be 2" type="AssertionError"/></testcase>
    <testcase classname="a.test.ts" name="[TC-09] 計画にない"><failure message="expected" type="AssertionError"/></testcase>
  </testsuite></testsuites>`
  const text = evaluateRed(tcs("TC-01"), parseJUnit(xml)).problems.join("\n")
  assert.match(text, /既存のテスト.*古いテスト/)
  assert.match(text, /TC-09.*計画にない/)
})

// ---- red の工程（advance） ----

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim()

const PLAN = `---\nstatus: done\napproved: true\nissue: 12\n---\n| ID | 対応する AC | 種別 | テストの内容 | テストファイル |\n|---|---|---|---|---|\n| TC-01 | AC-1 | 正常系 | 空白 | src/slug.test.ts |\n| TC-02 | AC-2 | 異常系 | 空 | src/slug.test.ts |\n`

// 偽の子セッションは呼ばれるたびにテストファイルを書き、偽のテスト実行は junits の先頭を JUnit として書き出す
const setup = (junits: string[], opts: { maxWrites?: number } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "harness-red-"))
  const worktree = join(root, "wt")
  mkdirSync(worktree)
  git(worktree, "init", "-q", "-b", "feat/12-x")
  mkdirSync(join(worktree, ".opencode"))
  writeFileSync(join(worktree, ".opencode", "package.json"), "{ }\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "base")
  mkdirSync(join(worktree, ".harness", "run"), { recursive: true })
  writeFileSync(join(worktree, ".harness", ".gitignore"), "*\n")
  writeFileSync(join(worktree, ".harness", "run", "01-plan.md"), PLAN)

  const store = createStore(root)
  const { run } = startRun(store, { kind: "dev", issue: 12 })
  store.save({ ...run, step: "red", worktree, branch: "feat/12-x", title: "x" })
  const { config } = validateConfig({
    models: { "dev.test-writer": ["openai/gpt-6-sol"] },
    checks: [
      { name: "typecheck", command: "npx tsc --noEmit" },
      { name: "test", command: "npx vitest run --reporter=junit --outputFile=.harness/run/junit.xml", junit: ".harness/run/junit.xml" },
    ],
    tests: { globs: ["**/*.test.ts"] },
  })
  assert.ok(config)

  const childCalls: (RunChildOptions & { runId: string })[] = []
  const child = async (o: RunChildOptions & { runId: string }): Promise<ChildResult> => {
    childCalls.push(o)
    mkdirSync(join(worktree, "src"), { recursive: true })
    writeFileSync(join(worktree, "src", "slug.test.ts"), `// attempt ${childCalls.length}\n`)
    // opencode は worktree でプラグインの依存を入れるときに .opencode/package.json を書き換える
    writeFileSync(join(worktree, ".opencode", "package.json"), "{}")
    return { status: "completed", sessionID: o.sessionID ?? "ses_red_1", text: "ok", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, model: o.model }
  }
  const shellCalls: string[] = []
  const shell = async (command: string, o: { cwd: string }): Promise<ShellResult> => {
    shellCalls.push(command)
    const xml = junits.shift()
    if (xml !== undefined) writeFileSync(join(o.cwd, ".harness", "run", "junit.xml"), xml)
    return { code: 1, stdout: "", stderr: "", timedOut: false, durationMs: 10 }
  }
  const deps: StepDeps = { root, config, store, exec: realExec, shell, child }
  return { deps, store, worktree, childCalls, shellCalls, runId: run.id }
}

test("red が合格したら、テストをチェックポイントとして commit し、工程を green に進めて記録を残す", async () => {
  const { deps, store, worktree, childCalls, shellCalls, runId } = setup([fixture("vitest-red.junit.xml")])
  const result = await advance(deps, runId)

  assert.equal(result.kind, "continue")
  assert.equal(childCalls[0]?.agent, "test-writer")
  assert.equal(childCalls[0]?.model, "openai/gpt-6-sol")
  assert.match(childCalls[0]?.prompt ?? "", /TC-01/)
  // JUnit を出すチェック（テスト）だけを実行する
  assert.deepEqual(shellCalls, ["npx vitest run --reporter=junit --outputFile=.harness/run/junit.xml"])
  // テストを書く役は、テストの実行コマンドを使える
  assert.ok(childCalls[0]?.permission?.some((r) => r.permission === "bash" && r.pattern === "npx vitest*" && r.action === "allow"))

  const run = store.get(runId)
  assert.equal(run?.step, "green")
  assert.equal(run?.redCommit, git(worktree, "rev-parse", "HEAD"))
  assert.match(git(worktree, "log", "-1", "--format=%s"), /#12/)
  assert.match(readFileSync(join(worktree, ".harness", "run", "02-red.md"), "utf8"), /合格/)
  // チェックポイントには、テストとスタブだけを含め、ハーネス自身（.opencode/）の変更は含めない
  assert.deepEqual(git(worktree, "show", "--name-only", "--format=", "HEAD").split("\n"), ["src/slug.test.ts"])
  assert.equal(git(worktree, "status", "--porcelain"), "M .opencode/package.json")
})

test("red が不合格なら、理由を添えて同じ test-writer の子セッションに差し戻し、合格すれば進む", async () => {
  const { deps, store, childCalls, runId } = setup([fixture("vitest-mixed.junit.xml"), fixture("vitest-red.junit.xml")])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  assert.equal(childCalls.length, 2)
  assert.equal(childCalls[1]?.sessionID, "ses_red_1")
  assert.match(childCalls[1]?.prompt ?? "", /Cannot find module/)
  assert.equal(store.get(runId)?.step, "green")
})

test("差し戻しを 2 回しても不合格なら、エスカレーションし、理由を 02-red.md に残す", async () => {
  const mixed = fixture("vitest-mixed.junit.xml")
  const { deps, store, worktree, childCalls, runId } = setup([mixed, mixed, mixed])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "escalated")
  assert.equal(childCalls.length, 3)
  const run = store.get(runId)
  assert.equal(run?.status, "escalated")
  assert.equal(run?.step, "red")
  assert.match(readFileSync(join(worktree, ".harness", "run", "02-red.md"), "utf8"), /Cannot find module/)
})

test("テストの実行で JUnit が出力されなければ、そのことを理由に差し戻す", async () => {
  const { deps, childCalls, runId } = setup([])
  await advance(deps, runId)
  assert.match(childCalls[1]?.prompt ?? "", /JUnit/)
})

test("JUnit を出力するチェックが設定になければ、子セッションを動かさずにエラーを返す", async () => {
  const { deps, childCalls, runId } = setup([])
  const noJunit = { ...deps, config: { ...deps.config, checks: deps.config.checks.filter((c) => !c.junit) } }
  const result = await advance(noJunit, runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /junit/)
  assert.equal(childCalls.length, 0)
})
