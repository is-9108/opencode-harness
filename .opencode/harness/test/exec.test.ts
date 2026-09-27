import { test } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { realShell } from "../exec.ts"

test("シェルのコマンドの終了コードと出力を返す", async () => {
  const r = await realShell(`node -e "console.log('out'); console.error('err'); process.exit(3)"`, { cwd: tmpdir(), timeoutSec: 30 })
  assert.equal(r.code, 3)
  assert.match(r.stdout, /out/)
  assert.match(r.stderr, /err/)
  assert.equal(r.timedOut, false)
})

test("タイムアウトしたら子孫のプロセスごと止め、timedOut を返す", async () => {
  const started = Date.now()
  const r = await realShell(`node -e "setTimeout(() => {}, 60000)"`, { cwd: tmpdir(), timeoutSec: 1 })
  assert.equal(r.timedOut, true)
  assert.ok(Date.now() - started < 20_000, "タイムアウト後すぐに戻るはず")
})
