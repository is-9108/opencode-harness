import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advance, type StepDeps } from "../machine/dev.ts"
import { parseReview } from "../steps/review.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import { realExec } from "../exec.ts"
import type { ChildResult, RunChildOptions } from "../session.ts"
import { noShell } from "./fakes.ts"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim()

const review = (rows: string[], status = "done") => `---
status: ${status}
perspective: spec
---
# spec の観点のレビュー

## 指摘
| ID | 分類 | blocking | AC | 根拠（ファイル:行） | 内容 |
|---|---|---|---|---|---|
${rows.join("\n")}
`

const VIOLATION = "| F-01 | spec_violation | yes | AC-2 | src/slug.ts:2 | 記号だけの入力で空文字を返していない |"
const NO_EVIDENCE = "| F-02 | spec_violation | yes | AC-1 | なし | なんとなく仕様と違う気がする |"
const NO_AC = "| F-03 | spec_violation | yes | - | src/slug.ts:1 | 命名が要件と違う |"
const ADVISORY = "| F-04 | other | no | - | src/slug.ts:1 | 変数名をもっと分かりやすく |"

// ---- 指摘の読み取りと集計 ----

test("根拠（AC の ID と「ファイル:行」）がそろった spec_violation だけを blocking として数える", () => {
  const parsed = parseReview(review([VIOLATION, NO_EVIDENCE, NO_AC, ADVISORY]))
  assert.deepEqual(parsed.problems, [])
  assert.deepEqual(parsed.blocking.map((f) => f.id), ["F-01"])
  assert.deepEqual(parsed.downgraded.map((d) => [d.finding.id, d.reason]), [
    ["F-02", "根拠（ファイル:行）がありません"],
    ["F-03", "対応する AC の ID がありません"],
  ])
  assert.deepEqual(parsed.nonBlocking.map((f) => f.id), ["F-04"])
})

test("完了マーカーがない、または指摘の表がないレビューは不完全として扱う", () => {
  assert.match(parseReview(review([VIOLATION], "draft")).problems.join(), /status: done/)
  assert.match(parseReview("---\nstatus: done\n---\n# レビュー\n指摘はありません\n").problems.join(), /指摘の表/)
  // 指摘が 0 件の表は正しい（完全）
  assert.deepEqual(parseReview(review([])).problems, [])
})

test("分類や blocking の値が決まりに沿わない行は、不完全として指摘する", () => {
  const bad = "| F-09 | bug | maybe | AC-1 | src/a.ts:1 | ? |"
  const problems = parseReview(review([bad])).problems.join("\n")
  assert.match(problems, /F-09.*分類/)
  assert.match(problems, /F-09.*blocking/)
})

// ---- review の工程 ----

type Call = RunChildOptions & { runId: string }

const setup = (outputs: (string | undefined)[], opts: { models?: Record<string, string[]>; stacked?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "harness-review-"))
  const worktree = join(root, "wt")
  mkdirSync(join(worktree, "src"), { recursive: true })
  git(worktree, "init", "-q", "-b", "main")
  writeFileSync(join(worktree, "README.md"), "base\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "base")
  // 依存先の issue のブランチに積んだ run（#31）: 依存先の変更はレビューの差分に含めない
  if (opts.stacked) {
    git(worktree, "switch", "-q", "-c", "feat/6-dep")
    writeFileSync(join(worktree, "src", "dep.ts"), "export const dep = 1\n")
    git(worktree, "add", "-A")
    git(worktree, "commit", "-q", "-m", "dep")
  }
  git(worktree, "switch", "-q", "-c", "feat/7-x")
  writeFileSync(join(worktree, "src", "slug.ts"), "export const slugify = (s: string) => s.replace(/ /g, '-')\n")
  mkdirSync(join(worktree, ".opencode"))
  writeFileSync(join(worktree, ".opencode", "package.json"), "{}\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "green")
  mkdirSync(join(worktree, ".harness", "run"), { recursive: true })
  writeFileSync(join(worktree, ".harness", ".gitignore"), "*\n")
  writeFileSync(join(worktree, ".harness", "run", "00-issue.md"), "# #7 slug\n")
  writeFileSync(join(worktree, ".harness", "run", "01-plan.md"), "---\nstatus: done\n---\n")

  const store = createStore(root)
  const { run } = startRun(store, { kind: "dev", issue: 7 })
  store.save({ ...run, step: "review", worktree, branch: "feat/7-x", ...(opts.stacked ? { baseBranch: "feat/6-dep" } : {}) })
  const { config } = validateConfig({
    models: opts.models ?? { "dev.review.spec": ["openai/gpt-6-sol"] },
    checks: [{ name: "test", command: "npm test", junit: "j.xml" }],
    tests: { globs: ["**/*.test.ts"] },
  })
  assert.ok(config)
  const calls: Call[] = []
  const child = async (o: Call): Promise<ChildResult> => {
    calls.push(o)
    const out = outputs.shift()
    const dir = join(worktree, ".harness", "run", "reviews", "round-1")
    mkdirSync(dir, { recursive: true })
    if (out !== undefined) writeFileSync(join(dir, "spec.md"), out)
    return { status: "completed", sessionID: o.sessionID ?? "ses_review_1", text: "ok", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, model: o.model }
  }
  const deps: StepDeps = { root, config, store, exec: realExec, shell: noShell, child }
  const roundDir = join(worktree, ".harness", "run", "reviews", "round-1")
  return { deps, store, calls, roundDir, worktree, runId: run.id }
}

test("依存先のブランチに積んだ run では、依存先のブランチからの差分だけをレビューする", async () => {
  const { deps, roundDir, runId } = setup([review([])], { stacked: true })
  await advance(deps, runId)
  const diff = readFileSync(join(roundDir, "input.diff"), "utf8")
  assert.match(diff, /src\/slug\.ts/)
  assert.doesNotMatch(diff, /src\/dep\.ts/)
})

test("blocking が 0 件なら、summary.md に blocking_count: 0 を書いて pr に進む", async () => {
  const { deps, store, calls, roundDir, runId } = setup([review([ADVISORY])])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "continue")
  assert.equal(calls[0]?.agent, "reviewer")
  assert.equal(calls[0]?.model, "openai/gpt-6-sol")
  assert.match(readFileSync(join(roundDir, "summary.md"), "utf8"), /blocking_count: 0/)
  assert.equal(store.get(runId)?.step, "pr")
  assert.equal(store.get(runId)?.reviewRounds, 1)
})

test("レビューの入力として、ベースからの差分（.opencode を除く）・issue・計画を渡し、自分のレビューファイルだけを編集させる", async () => {
  const { deps, calls, roundDir, runId } = setup([review([])])
  await advance(deps, runId)
  const diff = readFileSync(join(roundDir, "input.diff"), "utf8")
  assert.match(diff, /src\/slug\.ts/)
  assert.doesNotMatch(diff, /\.opencode/)
  const prompt = calls[0]?.prompt ?? ""
  assert.ok(prompt.includes(join(roundDir, "input.diff")))
  assert.ok(prompt.includes("00-issue.md") && prompt.includes("01-plan.md"))
  // 観点のチェックリストを差し込む
  assert.match(prompt, /受け入れ基準/)
  const rules = calls[0]?.permission ?? []
  assert.ok(rules.some((r) => r.permission === "edit" && r.pattern === "*" && r.action === "deny"))
  assert.ok(rules.some((r) => r.permission === "edit" && r.action === "allow" && r.pattern.endsWith("spec.md")))
})

test("根拠のある blocking の指摘があれば、M1 では escalated にし、指摘の内容を示す", async () => {
  const { deps, store, roundDir, runId } = setup([review([VIOLATION, NO_EVIDENCE])])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "escalated")
  assert.match(result.message, /F-01.*AC-2.*src\/slug\.ts:2/)
  const summary = readFileSync(join(roundDir, "summary.md"), "utf8")
  assert.match(summary, /blocking_count: 1/)
  assert.match(summary, /F-02.*根拠/)
  assert.equal(store.get(runId)?.status, "escalated")
  // エスカレーションの報告に、未解決の論点として指摘を載せる（#33）
  assert.match(readFileSync(store.get(runId)?.lastEscalation?.report ?? "", "utf8"), /## 未解決の論点[\s\S]*F-01/)
  assert.equal(store.get(runId)?.step, "review")
})

test("レビューが不完全なら同じ子セッションに 1 回だけ直させ、それでも不完全ならエラーにする", async () => {
  const { deps, store, calls, runId } = setup([review([VIOLATION], "draft"), undefined])
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.sessionID, "ses_review_1")
  assert.match(calls[1]?.prompt ?? "", /status: done/)
  assert.equal(store.get(runId)?.step, "review")
})

test("models に spec の観点のモデルがなければ、子セッションを作らずにエラーを返す", async () => {
  const { deps, calls, runId } = setup([review([])], { models: {} })
  const result = await advance(deps, runId)
  assert.equal(result.kind, "error")
  assert.match(result.message, /dev\.review\.spec/)
  assert.equal(calls.length, 0)
})
