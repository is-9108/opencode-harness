// test-fix / テストの変更申請 / review-fix のテストで共通に使う組み立て（checks と修正の工程を、偽のシェルと偽の子エージェントで動かす）
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { advance, type StepDeps, type StepResult } from "../machine/dev.ts"
import { createLock } from "../testing/lock.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import { realExec, type ShellResult } from "../exec.ts"
import type { ChildResult, RunChildOptions } from "../session.ts"

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim()

export const junit = (failed: string[]) =>
  `<testsuites><testsuite name="s">${failed
    .map((n) => `<testcase classname="src/slug.test.ts" name="${n}"><failure type="AssertionError" message="expected a to be b"/></testcase>`)
    .join("")}<testcase classname="src/slug.test.ts" name="[TC-00] ok"/></testsuite></testsuites>`
export const FAIL = (name = "[TC-01] a") => ({ code: 1, junit: junit([name]) })
export const PASS = { code: 0, junit: junit([]) }

export type Call = RunChildOptions & { runId: string }
export type Behave = (worktree: string, call: Call, k: number) => ChildResult["status"]

// test-fixer の記録を書き、実装を少し変える（commit できる差分を作る）
export const fixIt: Behave = (wt, _call, k) => {
  mkdirSync(join(wt, ".harness", "run", "test-fix"), { recursive: true })
  writeFileSync(join(wt, ".harness", "run", "test-fix", `${k}.md`), `---\nstatus: done\n---\n## 原因\n境界値の扱いが逆だった（${k} 回目）\n\n## 修正\nsrc/slug.ts の条件を直した\n`)
  writeFileSync(join(wt, "src", "slug.ts"), `export const slugify = (s: string) => s.replace(/ /g, "-") // fix ${k}\n`)
  return "completed"
}

// reviewer: 依頼にある出力先に、指摘の表を書く
export const reviewer =
  (...rows: string[]): Behave =>
  (_wt, call) => {
    const output = call.prompt.match(/出力先: (\S+?)（/)?.[1]
    assert.ok(output, "レビューの依頼に出力先がない")
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `---\nstatus: done\nperspective: spec\n---\n## 指摘\n| ID | 分類 | blocking | AC | 根拠（ファイル:行） | 内容 |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`)
    return "completed"
  }

// review-fixer: 依頼にある記録ファイルに対応を書き、実装を少し変える
export const fixer: Behave = (wt, call) => {
  const record = call.prompt.match(/[^\s（、]*review-fix[\\/]\d+\.md/)?.[0]
  assert.ok(record, "review-fix の依頼に記録ファイルがない")
  const k = record.match(/(\d+)\.md$/)?.[1]
  mkdirSync(dirname(record), { recursive: true })
  writeFileSync(record, `---\nstatus: done\n---\n## 対応\nF-01: 直した\n\n## 修正\n記号だけの入力を空文字にした（${k} 回目）\n`)
  writeFileSync(join(wt, "src", "slug.ts"), `export const slugify = (s: string) => s.replace(/ /g, "-") // review-fix ${k}\n`)
  return "completed"
}

// "throw" は、子セッションの途中で opencode ごと落ちたことを表す
export const setupLoop = (checks: { code: number; junit: string }[], behaviors: (Behave | "throw")[] = [], opts: { loops?: Record<string, number>; budget?: Record<string, number>; models?: Record<string, string[]> } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "harness-testfix-"))
  const worktree = join(root, "wt")
  mkdirSync(join(worktree, "src"), { recursive: true })
  git(worktree, "init", "-q", "-b", "main")
  writeFileSync(join(worktree, "README.md"), "base\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "base")
  git(worktree, "switch", "-q", "-c", "feat/12-x")
  writeFileSync(join(worktree, "src", "slug.test.ts"), "test('[TC-01] a')\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "red")
  const redCommit = git(worktree, "rev-parse", "HEAD")
  writeFileSync(join(worktree, "src", "slug.ts"), "export const slugify = (s: string) => s\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "green")
  mkdirSync(join(worktree, ".harness", "run"), { recursive: true })
  writeFileSync(join(worktree, ".harness", ".gitignore"), "*\n")
  writeFileSync(join(worktree, ".harness", "run", "01-plan.md"), "---\nstatus: done\napproved: true\n---\n")
  createLock(worktree, ["**/*.test.ts"], redCommit)

  const store = createStore(root)
  const { run } = startRun(store, { kind: "dev", issue: 12 })
  store.save({ ...run, step: "checks", worktree, branch: "feat/12-x", redCommit })
  const { config } = validateConfig({
    models: opts.models ?? { "dev.implementer": ["openai/gpt-5.5"], "dev.test-fix": ["openai/gpt-5.6-sol"], "dev.review.spec": ["openai/gpt-6-sol"], "dev.review-fix": ["openai/gpt-5.7"] },
    checks: [{ name: "test", command: "npx vitest run", junit: "j.xml" }],
    tests: { globs: ["**/*.test.ts"], flakyRetries: 0 },
    ...(opts.loops ? { loops: opts.loops } : {}),
    ...(opts.budget ? { budget: opts.budget } : {}),
  })
  assert.ok(config)

  const shellCalls: string[] = []
  const shell = async (command: string, o: { cwd: string }): Promise<ShellResult> => {
    const s = checks[Math.min(shellCalls.length, checks.length - 1)]!
    shellCalls.push(command)
    writeFileSync(join(o.cwd, "j.xml"), s.junit)
    return { code: s.code, stdout: "", stderr: "", timedOut: false, durationMs: 1 }
  }
  const calls: Call[] = []
  const child = async (o: Call): Promise<ChildResult> => {
    calls.push(o)
    const sessionID = o.sessionID ?? `ses_fix_${calls.length}`
    o.onSession?.(sessionID)
    const k = store.get(run.id)?.testFix ?? 0
    const behave = behaviors.shift() ?? fixIt
    if (behave === "throw") throw new Error("opencode が強制終了された")
    const status = behave(worktree, o, k)
    if (status !== "completed") return { status: "error", sessionID, error: "boom" }
    return { status: "completed", sessionID, text: "ok", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, model: o.model }
  }
  const deps: StepDeps = { root, config, store, exec: realExec, shell, child }
  // continue の間は、stopAt の工程に着くまで進める
  const drive = async (max = 20, stopAt = "review"): Promise<StepResult> => {
    let r: StepResult = { kind: "continue", message: "" }
    for (let i = 0; i < max && r.kind === "continue"; i++) {
      if (store.get(run.id)?.step === stopAt) break
      r = await advance(deps, run.id)
    }
    return r
  }
  return { deps, store, worktree, calls, shellCalls, drive, runId: run.id }
}
