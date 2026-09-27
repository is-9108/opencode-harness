import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advance, type StepDeps } from "../machine/dev.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import { realExec, type Exec } from "../exec.ts"
import type { ChildResult, RunChildOptions } from "../session.ts"
import { noShell } from "./fakes.ts"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim()

const SECTIONS = ["## 概要", "## 関連 issue", "## 変更内容", "## テスト", "## レビュー", "## 確認してほしいこと"]
const body = (opts: { closes?: boolean; drop?: string; status?: string } = {}) =>
  [
    "---",
    `status: ${opts.status ?? "done"}`,
    "title: \"feat: 文字列を slug に変換する関数を追加 (#7)\"",
    "---",
    ...SECTIONS.filter((s) => s !== opts.drop).flatMap((s) => [s, s === "## 関連 issue" ? (opts.closes === false ? "issue #7" : "Closes #7") : `${s.slice(3)}の内容`, ""]),
  ].join("\n")

type Call = RunChildOptions & { runId: string }

const setup = (bodies: (string | undefined)[], opts: { bigDiff?: boolean; existingPr?: boolean; stacked?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "harness-pr-"))
  const origin = join(root, "origin.git")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin])
  const worktree = join(root, "wt")
  mkdirSync(join(worktree, "src"), { recursive: true })
  git(worktree, "init", "-q", "-b", "main")
  git(worktree, "remote", "add", "origin", origin)
  writeFileSync(join(worktree, "README.md"), "base\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "base")
  git(worktree, "push", "-q", "origin", "main")
  // 依存先の issue のブランチに積んだ run（#31）
  if (opts.stacked) git(worktree, "branch", "feat/6-dep")
  git(worktree, "switch", "-q", "-c", "feat/7-slug")
  const lines = opts.bigDiff ? 320 : 3
  writeFileSync(join(worktree, "src", "slug.ts"), Array.from({ length: lines }, (_, i) => `export const v${i} = ${i}`).join("\n") + "\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "green")
  mkdirSync(join(worktree, ".harness", "run", "checks"), { recursive: true })
  mkdirSync(join(worktree, ".harness", "run", "reviews", "round-1"), { recursive: true })
  writeFileSync(join(worktree, ".harness", ".gitignore"), "*\n")
  writeFileSync(join(worktree, ".harness", "run", "00-issue.md"), "# #7 slug\n")
  writeFileSync(join(worktree, ".harness", "run", "01-plan.md"), "---\nstatus: done\n---\n")
  writeFileSync(join(worktree, ".harness", "run", "checks", "run-1.md"), "---\nstatus: passed\n---\n")
  writeFileSync(join(worktree, ".harness", "run", "reviews", "round-1", "summary.md"), "---\nblocking_count: 0\n---\n")

  const store = createStore(root)
  const { run } = startRun(store, { kind: "dev", issue: 7 })
  store.save({ ...run, step: "pr", worktree, branch: "feat/7-slug", checksRuns: 1, reviewRounds: 1, ...(opts.stacked ? { baseBranch: "feat/6-dep" } : {}) })
  // 子セッションのトークンの記録（PR 本文の「ハーネスの記録」に集計される）
  appendFileSync(join(root, ".harness", "runs", run.id, "events.jsonl"), JSON.stringify({ type: "child.completed", title: "issue-7: green", agent: "implementer", model: "openai/gpt-5.5", durationMs: 95000, tokens: { total: 12345 } }) + "\n")

  const { config } = validateConfig({
    models: { "dev.pr": ["openai/gpt-6-luna-fast"] },
    checks: [{ name: "test", command: "npm test", junit: "j.xml" }],
    tests: { globs: ["**/*.test.ts"] },
  })
  assert.ok(config)

  const gh: string[][] = []
  let pr = opts.existingPr ? { number: 42, url: "https://github.com/o/r/pull/42" } : undefined
  const exec: Exec = async (cmd, args, o) => {
    if (cmd !== "gh") return realExec(cmd, args, o)
    gh.push(args)
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(pr ? [pr] : []), stderr: "" }
    if (args[0] === "pr" && args[1] === "create") {
      pr = { number: 43, url: "https://github.com/o/r/pull/43" }
      return { code: 0, stdout: pr.url + "\n", stderr: "" }
    }
    if (args[0] === "pr" && args[1] === "edit") return { code: 0, stdout: "", stderr: "" }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` }
  }
  const calls: Call[] = []
  const child = async (o: Call): Promise<ChildResult> => {
    calls.push(o)
    const b = bodies.shift()
    if (b !== undefined) writeFileSync(join(worktree, ".harness", "run", "pr-body.md"), b)
    return { status: "completed", sessionID: o.sessionID ?? "ses_pr_1", text: "ok", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, model: o.model }
  }
  const deps: StepDeps = { root, config, store, exec, shell: noShell, child }
  // gh に渡した本文のファイルの中身を読む
  const postedBody = (args: string[]) => readFileSync(args[args.indexOf("--body-file") + 1] as string, "utf8")
  return { deps, store, gh, calls, origin, worktree, postedBody, runId: run.id }
}

test("pr-writer が書いた本文で、push して PR を作り、run を完了にする", async () => {
  const { deps, store, gh, calls, origin, postedBody, runId } = setup([body()])
  const result = await advance(deps, runId)

  assert.equal(result.kind, "done")
  assert.match(result.message, /pull\/43/)
  assert.equal(calls[0]?.agent, "pr-writer")
  assert.equal(calls[0]?.model, "openai/gpt-6-luna-fast")
  // push されている
  assert.equal(git(origin, "rev-parse", "feat/7-slug"), git(join(deps.root, "wt"), "rev-parse", "HEAD"))
  const create = gh.find((a) => a[1] === "create")
  assert.ok(create)
  assert.deepEqual(create.slice(create.indexOf("--base"), create.indexOf("--base") + 2), ["--base", "main"])
  assert.equal(create[create.indexOf("--title") + 1], "feat: 文字列を slug に変換する関数を追加 (#7)")
  const posted = postedBody(create)
  for (const s of SECTIONS) assert.ok(posted.includes(s), `${s} がある`)
  assert.match(posted, /Closes #7/)
  assert.doesNotMatch(posted, /^---/) // frontmatter は取り除く
  // ハーネスが集計した記録（トークン数など）を載せる
  assert.match(posted, /## ハーネスの記録/)
  assert.match(posted, /12,345/)
  const run = store.get(runId)
  assert.equal(run?.status, "done")
  assert.equal(run?.prUrl, "https://github.com/o/r/pull/43")
})

test("依存先のブランチに積んだ run では、PR の base を依存先のブランチにする", async () => {
  const { deps, gh, runId } = setup([body()], { stacked: true })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "done")
  const create = gh.find((a) => a[1] === "create")
  assert.ok(create)
  assert.equal(create[create.indexOf("--base") + 1], "feat/6-dep")
})

test("同じブランチの PR がすでにあれば、新しく作らずに本文を更新する", async () => {
  const { deps, gh, postedBody, runId } = setup([body()], { existingPr: true })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "done")
  assert.equal(gh.some((a) => a[1] === "create"), false)
  const edit = gh.find((a) => a[1] === "edit")
  assert.ok(edit)
  assert.equal(edit[2], "42")
  assert.match(postedBody(edit), /Closes #7/)
})

test("差分が 300 行を超えたら、本文の先頭に警告を載せる", async () => {
  const { deps, gh, postedBody, runId } = setup([body()], { bigDiff: true })
  await advance(deps, runId)
  const posted = postedBody(gh.find((a) => a[1] === "create") ?? [])
  assert.match(posted.split("\n").slice(0, 3).join("\n"), /300 行を超えて/)
})

test("セクションの欠落や Closes の書き忘れは、同じ子セッションに 1 回だけ直させる", async () => {
  const { deps, calls, runId } = setup([body({ closes: false, drop: "## 確認してほしいこと" }), body()])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "done")
  assert.equal(calls[1]?.sessionID, "ses_pr_1")
  assert.match(calls[1]?.prompt ?? "", /Closes #7/)
  assert.match(calls[1]?.prompt ?? "", /確認してほしいこと/)
})

test("直させても本文が不完全なら、PR を作らずにエラーを返す", async () => {
  const { deps, store, gh, runId } = setup([body({ status: "draft" }), body({ status: "draft" })])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.equal(gh.length, 0)
  assert.equal(store.get(runId)?.step, "pr")
})

test("子セッションには、テンプレートと成果物の場所を渡し、本文のファイルだけを編集させる", async () => {
  const { deps, calls, runId } = setup([body()])
  await advance(deps, runId)
  const prompt = calls[0]?.prompt ?? ""
  for (const s of SECTIONS) assert.ok(prompt.includes(s))
  assert.match(prompt, /Closes #7/)
  assert.match(prompt, /checks[\\/]run-1\.md/)
  assert.match(prompt, /round-1[\\/]summary\.md/)
  // 差分はハーネス自身の .opencode/ を除いたものを見させる
  assert.match(prompt, /:\(exclude\)\.opencode/)
  assert.ok(calls[0]?.permission?.some((r) => r.permission === "edit" && r.action === "allow" && r.pattern.endsWith("pr-body.md")))
})
