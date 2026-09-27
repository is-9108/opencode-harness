import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advance, type StepDeps } from "../machine/dev.ts"
import { createLock } from "../testing/lock.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import { realExec } from "../exec.ts"
import type { ChildResult, RunChildOptions } from "../session.ts"
import { noShell } from "./fakes.ts"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim()

const PLAN = `---\nstatus: done\napproved: true\nissue: 12\n---\n| ID | 対応する AC | 種別 | テストの内容 | テストファイル |\n|---|---|---|---|---|\n| TC-01 | AC-1 | 正常系 | 空白をハイフンにする | src/slug.test.ts |\n| TC-02 | AC-2 | 異常系 | 空文字は空文字 | src/slug.test.ts |\n`

type Call = RunChildOptions & { runId: string }
// 偽の implementer。behave で、呼ばれるたびの振る舞いを決める
type Behave = (worktree: string, call: Call) => ChildResult["status"]

const markLog = (worktree: string, ids: string[], done: boolean) => {
  const path = join(worktree, ".harness", "run", "03-green-log.md")
  let log = readFileSync(path, "utf8")
  for (const id of ids) log = log.replace(`- [ ] ${id}`, `- [x] ${id}`)
  if (done) log = log.replace("status: in_progress", "status: done")
  writeFileSync(path, log)
}

const setup = (behaviors: Behave[]) => {
  const root = mkdtempSync(join(tmpdir(), "harness-green-"))
  const worktree = join(root, "wt")
  mkdirSync(join(worktree, "src"), { recursive: true })
  git(worktree, "init", "-q", "-b", "feat/12-x")
  writeFileSync(join(worktree, "src", "slug.test.ts"), "test('[TC-01]') test('[TC-02]')\n")
  writeFileSync(join(worktree, "src", "slug.ts"), "export const slugify = () => { throw new Error('not implemented') }\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "red")
  mkdirSync(join(worktree, ".harness", "run"), { recursive: true })
  writeFileSync(join(worktree, ".harness", ".gitignore"), "*\n")
  writeFileSync(join(worktree, ".harness", "run", "01-plan.md"), PLAN)
  const redCommit = git(worktree, "rev-parse", "HEAD")
  createLock(worktree, ["**/*.test.ts"], redCommit)

  const store = createStore(root)
  const { run } = startRun(store, { kind: "dev", issue: 12 })
  store.save({ ...run, step: "green", worktree, branch: "feat/12-x", redCommit })
  const { config } = validateConfig({
    models: { "dev.implementer": ["openai/gpt-5.5"] },
    checks: [{ name: "test", command: "npx vitest run --reporter=junit --outputFile=j.xml", junit: "j.xml" }],
    tests: { globs: ["**/*.test.ts"] },
  })
  assert.ok(config)
  const calls: Call[] = []
  const child = async (o: Call): Promise<ChildResult> => {
    calls.push(o)
    o.onSession?.(o.sessionID ?? "ses_green_1")
    const behave = behaviors.shift()
    const status = behave ? behave(worktree, o) : "completed"
    const sessionID = o.sessionID ?? "ses_green_1"
    if (status === "aborted") return { status: "aborted", sessionID }
    if (status === "error") return { status: "error", sessionID, error: "APIError: boom" }
    return { status: "completed", sessionID, text: "ok", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, model: o.model }
  }
  const deps: StepDeps = { root, config, store, exec: realExec, shell: noShell, child }
  const logPath = join(worktree, ".harness", "run", "03-green-log.md")
  return { deps, store, worktree, calls, logPath, runId: run.id }
}

// 実装を書き、すべてのケースにチェックを付けて完了にする
const finishAll: Behave = (wt) => {
  writeFileSync(join(wt, "src", "slug.ts"), "export const slugify = (s: string) => s.replace(/ /g, '-')\n")
  markLog(wt, ["TC-01", "TC-02"], true)
  return "completed"
}

test("green の工程で、テストケースごとのチェックボックスを用意し、implementer が全部終えたら commit して checks に進む", async () => {
  const { deps, store, worktree, calls, logPath, runId } = setup([
    (wt, call) => {
      // 依頼の時点で、計画のテストケースのチェックボックスが用意されている
      assert.match(readFileSync(logPath, "utf8"), /- \[ \] TC-01[\s\S]*- \[ \] TC-02/)
      assert.match(call.prompt, /03-green-log\.md/)
      return finishAll(wt, call)
    },
  ])
  const result = await advance(deps, runId)

  assert.equal(result.kind, "continue")
  assert.equal(calls[0]?.agent, "implementer")
  assert.equal(calls[0]?.model, "openai/gpt-5.5")
  const run = store.get(runId)
  assert.equal(run?.step, "checks")
  assert.equal(run?.greenCommit, git(worktree, "rev-parse", "HEAD"))
  assert.deepEqual(git(worktree, "show", "--name-only", "--format=", "HEAD").split("\n"), ["src/slug.ts"])
  assert.match(readFileSync(logPath, "utf8"), /status: done/)
})

test("green の子セッションには、テストファイルの編集を拒否する権限（ロック）を、編集の許可より後に渡す", async () => {
  const { deps, calls, runId } = setup([finishAll])
  await advance(deps, runId)
  const rules = calls[0]?.permission ?? []
  const allowAll = rules.findIndex((r) => r.permission === "edit" && r.pattern === "*" && r.action === "allow")
  const denyTests = rules.findIndex((r) => r.permission === "edit" && r.pattern === "*.test.ts" && r.action === "deny")
  assert.ok(allowAll >= 0 && denyTests > allowAll, "後のルールが優先されるので、deny は allow より後に置く")
  assert.ok(rules.some((r) => r.permission === "edit" && r.pattern.endsWith("03-green-log.md") && r.action === "allow"))
})

test("green の途中で中断したら、次の advance で同じ子セッションに、green-log を見て続きから進めるよう送る", async () => {
  const { deps, store, calls, runId } = setup([
    (wt) => {
      markLog(wt, ["TC-01"], false)
      return "aborted"
    },
    (wt, call) => {
      assert.match(call.prompt, /続き/)
      return finishAll(wt, call)
    },
  ])
  const first = await advance(deps, runId)
  assert.equal(first.kind, "error")
  assert.equal(store.get(runId)?.step, "green")
  assert.equal(store.get(runId)?.sessions?.green, "ses_green_1")

  const second = await advance(deps, runId)
  assert.equal(second.kind, "continue")
  assert.equal(calls[1]?.sessionID, "ses_green_1")
})

test("green の子セッションの途中でプロセスごと落ちても、子セッションの ID は保存されていて、次は同じセッションで続きから進める", async () => {
  const { deps, store, calls, runId } = setup([
    () => {
      throw new Error("opencode が強制終了された")
    },
    (wt, call) => {
      assert.match(call.prompt, /続き/)
      return finishAll(wt, call)
    },
  ])
  await assert.rejects(advance(deps, runId), /強制終了/)
  assert.equal(store.get(runId)?.sessions?.green, "ses_green_1")
  assert.equal(store.get(runId)?.step, "green")

  const second = await advance(deps, runId)
  assert.equal(second.kind, "continue")
  assert.equal(calls[1]?.sessionID, "ses_green_1")
})

test("チェックが付いていないケースや完了マーカーがなければ、同じ子セッションに 1 回だけ直させる", async () => {
  const { deps, store, calls, runId } = setup([
    (wt) => {
      markLog(wt, ["TC-01"], false)
      return "completed"
    },
    finishAll,
  ])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.sessionID, "ses_green_1")
  assert.match(calls[1]?.prompt ?? "", /TC-02/)
  assert.equal(store.get(runId)?.step, "checks")
})

test("直させても終わっていなければ、未完了のケースを示してエラーを返し、工程は green のままにする", async () => {
  const partial: Behave = (wt) => {
    markLog(wt, ["TC-01"], false)
    return "completed"
  }
  const { deps, store, runId } = setup([partial, partial])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /TC-02/)
  assert.equal(store.get(runId)?.step, "green")
})

test("implementer がテストファイルを書き換えていたら、監査で元に戻し、工程を失敗として扱う", async () => {
  const { deps, store, worktree, runId } = setup([
    (wt, call) => {
      writeFileSync(join(wt, "src", "slug.test.ts"), "test('always passes')\n")
      return finishAll(wt, call)
    },
  ])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /元に戻しました/)
  assert.equal(store.get(runId)?.step, "green")
  assert.match(readFileSync(join(worktree, "src", "slug.test.ts"), "utf8"), /TC-01/)
})
