import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { advance, record } from "../machine/dev.ts"
import { parseDependencies } from "../steps/setup.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import { okShell } from "./fakes.ts"
import { realExec, type Exec } from "../exec.ts"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim()

const body = (deps: string) => `## 概要\nslug を追加する。#99 は参考。\n\n## 依存関係\n- 先に完了が必要な issue: ${deps}\n\n## サイズ\nS\n`

type Issue = { number: number; title: string; body: string; state: "OPEN" | "CLOSED"; url: string }
type Pr = { number: number; headRefName: string; body: string }

// gh の issue view は番号ごと、pr list は開いた PR の一覧を返す偽物。git は本物を使う
const setup = (opts: { deps: string; issues?: Issue[]; prs?: Pr[] }) => {
  const parent = mkdtempSync(join(tmpdir(), "harness-dep-"))
  const root = join(parent, "sample")
  mkdirSync(root)
  git(root, "init", "-q", "-b", "main")
  writeFileSync(join(root, "README.md"), "sample\n")
  // 実際のリポジトリと同じく、run の状態は git の管理外にする（ブランチを切り替えても消えないように）
  writeFileSync(join(root, ".gitignore"), ".harness/\n")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "init")

  const issues = new Map<number, Issue>([[12, { number: 12, title: "Add slug", body: body(opts.deps), state: "OPEN", url: "u" }]])
  for (const i of opts.issues ?? []) issues.set(i.number, i)
  const calls: string[][] = []
  const exec: Exec = async (cmd, args, o) => {
    calls.push([cmd, ...args])
    if (cmd !== "gh") return realExec(cmd, args, o)
    if (args[0] === "issue" && args[1] === "view") {
      const i = issues.get(Number(args[2]))
      return i ? { code: 0, stdout: JSON.stringify(i), stderr: "" } : { code: 1, stdout: "", stderr: "not found" }
    }
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(opts.prs ?? []), stderr: "" }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` }
  }
  const store = createStore(root)
  startRun(store, { kind: "dev", issue: 12 })
  const { config } = validateConfig({ models: {}, checks: [{ name: "test", command: "npm test" }], tests: { globs: ["**/*.test.ts"] } })
  assert.ok(config)
  const child = async (): Promise<never> => { throw new Error("setup で子セッションは呼ばれないはず") }
  const deps = { root, config, store, exec, shell: okShell(), child }
  const worktree = join(dirname(root), `${basename(root)}.worktrees`, "issue-12")
  return { root, store, deps, calls, worktree, runId: "issue-12", issues }
}

const closed = (n: number): Issue => ({ number: n, title: `dep ${n}`, body: "", state: "CLOSED", url: "u" })
const open = (n: number): Issue => ({ number: n, title: `dep ${n}`, body: "", state: "OPEN", url: "u" })

// 依存先の issue のブランチを、main から 1 コミット進めて作る
const depBranch = (root: string, name: string) => {
  git(root, "switch", "-q", "-c", name)
  writeFileSync(join(root, "dep.txt"), "dep\n")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "dep")
  git(root, "switch", "-q", "main")
  return git(root, "rev-parse", name)
}

test("依存関係のセクションから issue 番号だけを取り出す（ほかのセクションや自分自身は除く）", () => {
  assert.deepEqual(parseDependencies(body("#7、#8"), 12), [7, 8])
  assert.deepEqual(parseDependencies(body("なし"), 12), [])
  assert.deepEqual(parseDependencies(body("#12、#7"), 12), [7])
  assert.deepEqual(parseDependencies("## 概要\n#3 を参考に\n", 12), [])
})

test("依存先の issue がすべて閉じていれば、そのまま worktree を作って plan に進む（AC-1）", async () => {
  const { store, deps, worktree, runId } = setup({ deps: "#7、#8", issues: [closed(7), closed(8)] })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  assert.ok(existsSync(worktree))
  assert.equal(store.get(runId)?.step, "plan")
})

test("依存関係が「なし」なら、依存先を問い合わせない", async () => {
  const { deps, calls, runId } = setup({ deps: "なし" })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  assert.equal(calls.filter((c) => c[0] === "gh" && c[1] === "issue").length, 1)
})

test("依存先の issue が開いていれば、worktree を作らずに need_user になり、待つ・積む・無視の選択肢を示す（AC-2）", async () => {
  const { root, store, deps, worktree, runId } = setup({
    deps: "#7",
    issues: [open(7)],
    prs: [{ number: 20, headRefName: "feat/7-dep", body: "説明\n\nCloses #7" }],
  })
  depBranch(root, "feat/7-dep")
  const result = await advance(deps, runId)
  assert.equal(result.kind, "need_user")
  assert.match(result.message, /#7/)
  assert.match(result.message, /待つ/)
  assert.match(result.message, /積む/)
  assert.match(result.message, /feat\/7-dep/)
  assert.match(result.message, /無視/)
  assert.match(result.message, /harness_record/)
  assert.equal(existsSync(worktree), false)
  assert.equal(store.get(runId)?.step, "setup")
})

test("「積む」を選ぶと、依存先の issue のブランチ（PR の head）を起点に worktree を作り、以降の基準にする（AC-3）", async () => {
  const { root, store, deps, worktree, runId } = setup({
    deps: "#7",
    issues: [open(7)],
    prs: [{ number: 21, headRefName: "feat/other", body: "Closes #70" }, { number: 20, headRefName: "feat/7-dep", body: "説明\n\ncloses #7" }],
  })
  const depHead = depBranch(root, "feat/7-dep")
  assert.equal((await advance(deps, runId)).kind, "need_user")

  const recorded = record(deps, { run: runId, gate: "dependency", decision: "stack" })
  assert.equal(recorded.kind, "continue")
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  // 依存先のコミットの上に積まれている
  assert.equal(git(worktree, "merge-base", "--is-ancestor", depHead, "HEAD"), "")
  assert.equal(store.get(runId)?.baseBranch, "feat/7-dep")
  assert.equal(store.get(runId)?.step, "plan")
})

// origin（ベアリポジトリ）を作って main を push する
const withOrigin = (root: string) => {
  const origin = join(dirname(root), "origin.git")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin])
  git(root, "remote", "add", "origin", origin)
  git(root, "push", "-q", "origin", "main")
  return origin
}
const PR7 = [{ number: 20, headRefName: "feat/7-dep", body: "Closes #7" }]

test("PR の head のブランチが手元になく origin にあれば、fetch して手元のブランチを作り、積む先にする", async () => {
  const { root, deps, worktree, runId } = setup({ deps: "#7", issues: [open(7)], prs: PR7 })
  withOrigin(root)
  const depHead = depBranch(root, "feat/7-dep")
  git(root, "push", "-q", "origin", "feat/7-dep")
  git(root, "branch", "-q", "-D", "feat/7-dep")

  const result = await advance(deps, runId)
  assert.equal(result.kind, "need_user")
  assert.match(result.message, /feat\/7-dep/)
  assert.equal(git(root, "rev-parse", "feat/7-dep"), depHead)

  record(deps, { run: runId, gate: "dependency", decision: "stack" })
  assert.equal((await advance(deps, runId)).kind, "continue")
  assert.equal(git(worktree, "merge-base", "--is-ancestor", depHead, "HEAD"), "")
})

test("手元のブランチが origin より遅れていれば、早送りしてから積む", async () => {
  const { root, deps, runId } = setup({ deps: "#7", issues: [open(7)], prs: PR7 })
  withOrigin(root)
  const old = depBranch(root, "feat/7-dep")
  git(root, "switch", "-q", "feat/7-dep")
  writeFileSync(join(root, "dep2.txt"), "dep2\n")
  git(root, "add", "dep2.txt")
  git(root, "commit", "-q", "-m", "dep2")
  const latest = git(root, "rev-parse", "HEAD")
  git(root, "push", "-q", "origin", "feat/7-dep")
  git(root, "switch", "-q", "main")
  git(root, "branch", "-q", "-f", "feat/7-dep", old)

  assert.equal((await advance(deps, runId)).kind, "need_user")
  assert.equal(git(root, "rev-parse", "feat/7-dep"), latest)
})

test("手元のブランチが origin より進んでいれば、手元のまま使う", async () => {
  const { root, deps, runId } = setup({ deps: "#7", issues: [open(7)], prs: PR7 })
  withOrigin(root)
  depBranch(root, "feat/7-dep")
  git(root, "push", "-q", "origin", "feat/7-dep")
  git(root, "switch", "-q", "feat/7-dep")
  writeFileSync(join(root, "local.txt"), "local\n")
  git(root, "add", "local.txt")
  git(root, "commit", "-q", "-m", "local only")
  const local = git(root, "rev-parse", "HEAD")
  git(root, "switch", "-q", "main")

  assert.equal((await advance(deps, runId)).kind, "need_user")
  assert.equal(git(root, "rev-parse", "feat/7-dep"), local)
})

test("依存先の run が同じリポジトリにあれば、その run のブランチを積む先にする", async () => {
  const { root, store, deps, runId } = setup({ deps: "#7", issues: [open(7)] })
  depBranch(root, "feat/7-from-run")
  const { run: dep } = startRun(store, { kind: "dev", issue: 7 })
  store.save({ ...dep, step: "green", branch: "feat/7-from-run" })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "need_user")
  assert.match(result.message, /feat\/7-from-run/)
})

test("積む先のブランチが見つからなければ、「積む」を選択肢に出さず、選ばれてもエラーにする", async () => {
  const { deps, runId } = setup({ deps: "#7", issues: [open(7)] })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "need_user")
  assert.doesNotMatch(result.message, /積む/)
  const recorded = record(deps, { run: runId, gate: "dependency", decision: "stack" })
  assert.equal(recorded.kind, "error")
})

test("「待つ」を選ぶと、run は setup のまま止まり、次の /dev で再び依存先を確認する（AC-4）", async () => {
  const { store, deps, worktree, runId, issues } = setup({ deps: "#7", issues: [open(7)] })
  await advance(deps, runId)
  const waited = record(deps, { run: runId, gate: "dependency", decision: "wait" })
  assert.equal(waited.kind, "done")
  assert.match(waited.message, /#7/)
  assert.equal(store.get(runId)?.step, "setup")
  assert.equal(store.get(runId)?.status, "in_progress")
  assert.equal(existsSync(worktree), false)

  // まだ開いていれば、もう一度聞く
  assert.equal((await advance(deps, runId)).kind, "need_user")
  // 閉じたら進む
  issues.set(7, closed(7))
  assert.equal((await advance(deps, runId)).kind, "continue")
  assert.ok(existsSync(worktree))
})

test("「無視」を選ぶと、ベースブランチから worktree を作り、再開しても聞き直さない", async () => {
  const { root, store, deps, worktree, runId } = setup({ deps: "#7", issues: [open(7)] })
  await advance(deps, runId)
  assert.equal(record(deps, { run: runId, gate: "dependency", decision: "ignore" }).kind, "continue")
  assert.equal((await advance(deps, runId)).kind, "continue")
  assert.equal(git(worktree, "rev-parse", "HEAD"), git(root, "rev-parse", "main"))

  store.save({ ...store.get(runId)!, step: "setup" })
  assert.equal((await advance(deps, runId)).kind, "continue")
})

test("依存先の確認を待っていない run や、ゲートに合わない判断を記録しようとするとエラーにする", async () => {
  const { deps, runId } = setup({ deps: "なし" })
  assert.equal(record(deps, { run: runId, gate: "dependency", decision: "ignore" }).kind, "error")
  assert.equal(record(deps, { run: runId, gate: "dependency", decision: "approved" } as never).kind, "error")
  assert.equal(record(deps, { run: runId, gate: "plan", decision: "stack" } as never).kind, "error")
})
