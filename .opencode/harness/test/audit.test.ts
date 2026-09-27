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
import { noShell } from "./fakes.ts"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim()

// red が終わり、テストがロックされた状態の run を作る
const setup = (step: string) => {
  const root = mkdtempSync(join(tmpdir(), "harness-audit-"))
  const worktree = join(root, "wt")
  mkdirSync(join(worktree, "src"), { recursive: true })
  git(worktree, "init", "-q", "-b", "feat/1-x")
  writeFileSync(join(worktree, "src", "slug.test.ts"), "expect(slugify('a b')).toBe('a-b')\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "red")
  mkdirSync(join(worktree, ".harness", "run"), { recursive: true })
  writeFileSync(join(worktree, ".harness", ".gitignore"), "*\n")
  const redCommit = git(worktree, "rev-parse", "HEAD")
  createLock(worktree, ["**/*.test.ts"], redCommit)

  const store = createStore(root)
  const { run } = startRun(store, { kind: "dev", issue: 1 })
  store.save({ ...run, step, worktree, branch: "feat/1-x", redCommit })
  const { config } = validateConfig({ models: {}, checks: [{ name: "test", command: "x", junit: "j.xml" }], tests: { globs: ["**/*.test.ts"] } })
  assert.ok(config)
  const child = async (): Promise<never> => {
    throw new Error("子セッションは呼ばれないはず")
  }
  const deps: StepDeps = { root, config, store, exec: realExec, shell: noShell, child }
  return { deps, store, worktree, runId: run.id }
}

test("red より後の工程の後に監査し、テストファイルが変わっていたら元に戻して、その工程を失敗として記録する", async () => {
  const { deps, store, worktree, runId } = setup("green")
  // 工程の途中で、何らかの方法でテストが弱められたとする
  writeFileSync(join(worktree, "src", "slug.test.ts"), "expect(true).toBe(true)\n")
  const result = await advance(deps, runId)

  assert.equal(result.kind, "error")
  assert.match(result.message, /src\/slug\.test\.ts/)
  assert.match(result.message, /元に戻しました/)
  assert.equal(readFileSync(join(worktree, "src", "slug.test.ts"), "utf8").replace(/\r\n/g, "\n"), "expect(slugify('a b')).toBe('a-b')\n")
  assert.equal(store.get(runId)?.step, "green")
  assert.match(readFileSync(join(worktree, ".harness", "run", "test-audit.md"), "utf8"), /modified.*src\/slug\.test\.ts/)
  const events = readFileSync(join(deps.root, ".harness", "runs", runId, "events.jsonl"), "utf8")
  assert.match(events, /"type":"lock.violated"/)
})

test("テストファイルに変更がなければ、監査は工程の結果を変えない", async () => {
  const { deps, runId } = setup("green")
  const result = await advance(deps, runId)
  assert.doesNotMatch(result.message, /元に戻しました/)
})
