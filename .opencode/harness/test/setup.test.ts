import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { advance } from "../machine/dev.ts"
import { slugify } from "../steps/setup.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import { realExec, type Exec } from "../exec.ts"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim()

// 一時ディレクトリの中に、main に 1 コミットあるリポジトリを作る。worktree はその兄弟ディレクトリに作られる
const tempRepo = () => {
  const parent = mkdtempSync(join(tmpdir(), "harness-setup-"))
  const root = join(parent, "sample")
  mkdirSync(root)
  git(root, "init", "-q", "-b", "main")
  writeFileSync(join(root, "README.md"), "sample\n")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "init")
  return root
}

const ISSUE_BODY = "slug に変換する関数を追加する。\n\n## 受け入れ基準\n- AC-1: ..."

type GhIssue = { number: number; title: string; body: string; state: "OPEN" | "CLOSED"; url: string }
const openIssue: GhIssue = { number: 12, title: "Add slugify function", body: ISSUE_BODY, state: "OPEN", url: "https://github.com/o/r/issues/12" }

// gh だけを偽物にし、git は本物を使う。呼び出しを記録する
const fakeExec = (issue: GhIssue | undefined) => {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args, opts) => {
    calls.push([cmd, ...args])
    if (cmd === "gh") {
      if (!issue) return { code: 1, stdout: "", stderr: "GraphQL: Could not resolve to an issue or pull request with the number of 404. (repository.issue)" }
      return { code: 0, stdout: JSON.stringify(issue), stderr: "" }
    }
    return realExec(cmd, args, opts)
  }
  return { exec, calls }
}

const config = () => {
  const { config } = validateConfig({ models: {}, checks: [{ name: "test", command: "npm test" }], tests: { globs: ["**/*.test.ts"] } })
  assert.ok(config)
  return config
}

const setup = (issue: GhIssue | undefined, number = 12) => {
  const root = tempRepo()
  const store = createStore(root)
  startRun(store, { kind: "dev", issue: number })
  const { exec, calls } = fakeExec(issue)
  // setup の工程では子セッションを使わない
  const child = async (): Promise<never> => { throw new Error("setup で子セッションは呼ばれないはず") }
  const deps = { root, config: config(), store, exec, child }
  const worktree = join(dirname(root), `${basename(root)}.worktrees`, `issue-${number}`)
  return { root, store, deps, calls, worktree, runId: `issue-${number}` }
}

test("開いている issue の setup で、worktree とブランチを作り、issue のスナップショットを保存して continue を返す", async () => {
  const { store, deps, worktree, runId } = setup(openIssue)
  const result = await advance(deps, runId)

  assert.equal(result.kind, "continue")
  assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), "feat/12-add-slugify-function")
  const snapshot = readFileSync(join(worktree, ".harness", "run", "00-issue.md"), "utf8")
  assert.match(snapshot, /Add slugify function/)
  assert.ok(snapshot.includes(ISSUE_BODY))
  assert.ok(snapshot.includes(createHash("sha256").update(ISSUE_BODY).digest("hex")))
  // 成果物のディレクトリは git の管理から外す
  assert.equal(git(worktree, "status", "--porcelain"), "")

  const run = store.get(runId)
  assert.equal(run?.step, "plan")
  assert.equal(run?.worktree, worktree)
  assert.equal(run?.branch, "feat/12-add-slugify-function")
})

test("setup が完了した後にもう一度 advance しても、worktree やブランチを作り直さない", async () => {
  const { deps, calls, runId } = setup(openIssue)
  await advance(deps, runId)
  const second = await advance(deps, runId)
  assert.notEqual(second.kind, "continue")
  assert.equal(calls.filter((c) => c[0] === "git" && c.includes("worktree") && c.includes("add")).length, 1)
})

test("setup の途中で中断されて worktree だけが残っていても、再実行で既存の worktree を使う", async () => {
  const { store, deps, calls, worktree, runId } = setup(openIssue)
  await advance(deps, runId)
  const run = store.get(runId)
  assert.ok(run)
  store.save({ ...run, step: "setup" })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  assert.equal(calls.filter((c) => c[0] === "git" && c.includes("worktree") && c.includes("add")).length, 1)
  assert.ok(existsSync(join(worktree, ".harness", "run", "00-issue.md")))
})

test("ブランチだけが残っている場合は、そのブランチで worktree を作る", async () => {
  const { root, deps, worktree, runId } = setup(openIssue)
  git(root, "branch", "feat/12-add-slugify-function")
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), "feat/12-add-slugify-function")
})

test("存在しない issue なら、理由つきのエラーを返し、worktree を作らない", async () => {
  const { store, deps, worktree, runId } = setup(undefined, 404)
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /404/)
  assert.match(result.message, /Could not resolve/)
  assert.equal(existsSync(worktree), false)
  assert.equal(store.get(runId)?.step, "setup")
})

test("閉じている issue なら、エラーを返し、worktree を作らない", async () => {
  const { deps, worktree, runId } = setup({ ...openIssue, state: "CLOSED" })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /閉じて/)
  assert.equal(existsSync(worktree), false)
})

test("worktree の場所に git と関係のないディレクトリがあれば、上書きせずにエラーを返す", async () => {
  const { deps, worktree, runId } = setup(openIssue)
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, "keep.txt"), "user data")
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /worktree/)
  assert.equal(readFileSync(join(worktree, "keep.txt"), "utf8"), "user data")
})

test("存在しない run を advance したらエラーを返す", async () => {
  const { deps } = setup(openIssue)
  const result = await advance(deps, "issue-999")
  assert.equal(result.kind, "error")
  assert.match(result.message, /issue-999/)
})

test("slug はタイトルを英小文字・数字・ハイフンにし、長すぎれば切り詰め、英数字がなければ issue にする", () => {
  assert.equal(slugify("Add slugify function!"), "add-slugify-function")
  assert.equal(slugify("  Fix: user_name  (v2)  "), "fix-user-name-v2")
  assert.equal(slugify("日本語のタイトル"), "issue")
  assert.equal(slugify("ユーザー招待 API を追加"), "api")
  const long = slugify("a".repeat(30) + " " + "b".repeat(30))
  assert.ok(long.length <= 40)
  assert.doesNotMatch(long, /-$/)
})
