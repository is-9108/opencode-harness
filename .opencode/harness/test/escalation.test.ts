import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advance, type StepDeps } from "../machine/dev.ts"
import { escalate } from "../steps/escalation.ts"
import { createStore, startRun } from "../state.ts"
import { validateConfig } from "../config.ts"
import { formatStatus } from "../status.ts"
import { realExec } from "../exec.ts"
import { noShell } from "./fakes.ts"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim()

// main から 1 コミット進んだ worktree（diff の統計を取るため）
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "harness-esc-"))
  const worktree = join(root, "wt")
  mkdirSync(join(worktree, "src"), { recursive: true })
  git(worktree, "init", "-q", "-b", "main")
  writeFileSync(join(worktree, "README.md"), "base\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "base")
  git(worktree, "switch", "-q", "-c", "feat/7-x")
  writeFileSync(join(worktree, "src", "slug.ts"), "export const a = 1\nexport const b = 2\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "green")
  mkdirSync(join(worktree, ".harness", "run"), { recursive: true })

  const store = createStore(root)
  const { run } = startRun(store, { kind: "dev", issue: 7 })
  store.save({ ...run, step: "checks", worktree, branch: "feat/7-x", checksRuns: 3 })
  const { config } = validateConfig({ models: {}, checks: [{ name: "test", command: "npm test" }], tests: { globs: ["**/*.test.ts"] } })
  assert.ok(config)
  const child = async (): Promise<never> => {
    throw new Error("子セッションは呼ばれないはず")
  }
  const deps: StepDeps = { root, config, store, exec: realExec, shell: noShell, child }
  const report = (e: number) => join(worktree, ".harness", "run", `escalation-${e}.md`)
  return { deps, store, worktree, report, runId: run.id, config }
}

const sample = {
  reason: "loop_exhausted" as const,
  summary: "test-fix を 3 回繰り返しても checks が通りませんでした",
  history: ["checks 1 回目: test が失敗", "test-fix 1〜3 回目: 同じテストが失敗"],
  attempts: ["test-fix/1.md: 境界値の扱いを修正", "test-fix/2.md: 空文字の分岐を追加"],
  open: ["TC-03 の期待値が AC-2 と合っているか"],
}

test("エスカレーションの報告に、理由の種類・経緯・試した修正・diff の統計・未解決の論点を書き、run を escalated かつ human モードにする（AC-1）", async () => {
  const { deps, store, report, runId } = setup()
  const result = await escalate(deps, store.get(runId)!, sample)

  assert.equal(result.kind, "escalated")
  assert.match(result.message, /loop_exhausted/)
  assert.ok(result.message.includes(report(1)))
  assert.match(result.message, /\/fix 7/)

  const text = readFileSync(report(1), "utf8")
  assert.match(text, /reason: loop_exhausted/)
  assert.match(text, /test-fix を 3 回繰り返しても/)
  assert.match(text, /## 止まるまでの経緯[\s\S]*test-fix 1〜3 回目/)
  assert.match(text, /## 試した修正[\s\S]*境界値の扱いを修正/)
  assert.match(text, /## diff の統計[\s\S]*1 file changed, 2 insertions/)
  assert.match(text, /## 未解決の論点[\s\S]*TC-03/)

  const run = store.get(runId)
  assert.equal(run?.status, "escalated")
  assert.equal(run?.mode, "human")
  assert.equal(run?.step, "checks")
  assert.deepEqual(run?.lastEscalation, { number: 1, reason: "loop_exhausted", report: report(1) })
})

test("同じ run で 2 回目のエスカレーションは escalation-2.md に書き、1 回目は残す。human モードのまま戻さない（AC-2）", async () => {
  const { deps, store, report, runId } = setup()
  await escalate(deps, store.get(runId)!, sample)
  store.save({ ...store.get(runId)!, status: "in_progress" }) // /fix で再開した想定
  await escalate(deps, store.get(runId)!, { ...sample, reason: "no_progress", summary: "同じ失敗が 2 回続きました" })

  assert.ok(existsSync(report(1)))
  assert.match(readFileSync(report(2), "utf8"), /reason: no_progress/)
  assert.equal(store.get(runId)?.escalations, 2)
  assert.equal(store.get(runId)?.mode, "human")
})

test("報告を書いた後、状態を保存する前に落ちても、再実行で同じ番号の報告を書き直す", async () => {
  const { deps, store, report, runId } = setup()
  writeFileSync(report(1), "書きかけ")
  await escalate(deps, store.get(runId)!, sample)
  assert.match(readFileSync(report(1), "utf8"), /reason: loop_exhausted/)
  assert.equal(existsSync(report(2)), false)
})

test("エスカレーションした run の状態に、理由の種類と報告のパスを表示する（AC-3）", async () => {
  const { deps, store, report, runId, config } = setup()
  await escalate(deps, store.get(runId)!, sample)
  const text = formatStatus({ status: "ok", path: "/repo/harness.config.json", config, warnings: [] }, store.list())
  assert.match(text, /エスカレーション/)
  assert.match(text, /loop_exhausted/)
  assert.ok(text.includes(report(1)))
})

test("エスカレーションした run を advance すると、理由の種類と報告のパスを示して /fix を案内する", async () => {
  const { deps, store, report, runId } = setup()
  await escalate(deps, store.get(runId)!, sample)
  const result = await advance(deps, runId)
  assert.equal(result.kind, "escalated")
  assert.match(result.message, /loop_exhausted/)
  assert.ok(result.message.includes(report(1)))
  assert.match(result.message, /\/fix/)
})
