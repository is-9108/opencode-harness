import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { auditLock, createLock, globToRegExp, listTestFiles, lockPermissions, readLock } from "../testing/lock.ts"
import { realExec } from "../exec.ts"

const GLOBS = ["**/*.test.ts", "tests/**"]

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim()

const write = (root: string, rel: string, content: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true })
  writeFileSync(join(root, rel), content)
}

// テストファイルとそれ以外のファイルを commit したリポジトリを作り、ロックする
const setup = () => {
  const wt = mkdtempSync(join(tmpdir(), "harness-lock-"))
  git(wt, "init", "-q", "-b", "feat/1-x")
  write(wt, "src/slug.test.ts", "test 1\nline 2\n")
  write(wt, "src/slug.ts", "export {}\n")
  write(wt, "tests/e2e/flow.ts", "e2e\n")
  write(wt, "node_modules/pkg/x.test.ts", "vendored\n")
  write(wt, ".opencode/harness/test/a.test.ts", "harness\n")
  write(wt, ".gitignore", "node_modules/\n")
  git(wt, "add", "-A")
  git(wt, "commit", "-q", "-m", "red")
  mkdirSync(join(wt, ".harness", "run"), { recursive: true })
  writeFileSync(join(wt, ".harness", ".gitignore"), "*\n")
  const commit = git(wt, "rev-parse", "HEAD")
  const lock = createLock(wt, GLOBS, commit)
  return { wt, commit, lock }
}

test("glob を、パスの区切りをまたぐ ** と、またがない * として解釈する", () => {
  const re = globToRegExp("**/*.test.ts")
  assert.ok(re.test("a.test.ts"))
  assert.ok(re.test("src/deep/a.test.ts"))
  assert.equal(re.test("src/a.ts"), false)
  assert.ok(globToRegExp("tests/**").test("tests/e2e/flow.ts"))
  assert.equal(globToRegExp("src/*.ts").test("src/deep/a.ts"), false)
})

test("ロックは tests.globs に一致するファイルだけを対象にし、node_modules・.harness・.opencode は除く", () => {
  const { wt, commit, lock } = setup()
  assert.deepEqual(Object.keys(lock.files).sort(), ["src/slug.test.ts", "tests/e2e/flow.ts"])
  assert.equal(lock.commit, commit)
  assert.deepEqual(readLock(wt), lock)
  assert.deepEqual(listTestFiles(wt, GLOBS).sort(), ["src/slug.test.ts", "tests/e2e/flow.ts"])
})

test("テストファイルに変更がなければ、監査は問題なしを返す", async () => {
  const { wt } = setup()
  write(wt, "src/slug.ts", "export const slugify = () => ''\n") // テスト以外の変更は対象外
  const audit = await auditLock(realExec, wt, GLOBS)
  assert.deepEqual(audit, { ok: true, changes: [] })
})

test("変更・削除されたテストファイルを検知し、red のチェックポイントの内容に戻す", async () => {
  const { wt } = setup()
  write(wt, "src/slug.test.ts", "test 1 (weakened)\n")
  rmSync(join(wt, "tests/e2e/flow.ts"))
  const audit = await auditLock(realExec, wt, GLOBS)
  assert.equal(audit.ok, false)
  assert.deepEqual(audit.changes.map((c) => `${c.kind}:${c.file}`).sort(), ["deleted:tests/e2e/flow.ts", "modified:src/slug.test.ts"])
  // 戻したファイルの改行コードは、利用者の git の設定（core.autocrlf）に従う
  const lf = (rel: string) => readFileSync(join(wt, rel), "utf8").replace(/\r\n/g, "\n")
  assert.equal(lf("src/slug.test.ts"), "test 1\nline 2\n")
  assert.equal(lf("tests/e2e/flow.ts"), "e2e\n")
  // 戻した後は、監査で問題なしになる
  assert.equal((await auditLock(realExec, wt, GLOBS)).ok, true)
})

test("ロックの後に追加されたテストファイルは取り除く", async () => {
  const { wt } = setup()
  write(wt, "src/extra.test.ts", "sneaky\n")
  const audit = await auditLock(realExec, wt, GLOBS)
  assert.deepEqual(audit.changes, [{ file: "src/extra.test.ts", kind: "added" }])
  assert.equal(existsSync(join(wt, "src/extra.test.ts")), false)
})

test("改行コードだけが CRLF に変わったテストファイルは、変更とみなさない", async () => {
  const { wt } = setup()
  write(wt, "src/slug.test.ts", "test 1\r\nline 2\r\n")
  const audit = await auditLock(realExec, wt, GLOBS)
  assert.equal(audit.ok, true)
})

test("ロックがなければ、監査は何もしない", async () => {
  const wt = mkdtempSync(join(tmpdir(), "harness-lock-none-"))
  assert.deepEqual(await auditLock(realExec, wt, GLOBS), { ok: true, changes: [] })
})

test("子セッションに渡す権限: tests.globs のファイルの編集を拒否する（* はパスの区切りもまたぐ）", () => {
  assert.deepEqual(lockPermissions(GLOBS), [
    { permission: "edit", pattern: "*.test.ts", action: "deny" },
    { permission: "edit", pattern: "tests/*", action: "deny" },
  ])
})
