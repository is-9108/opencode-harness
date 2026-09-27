import { test } from "node:test"
import assert from "node:assert/strict"
import { formatStatus } from "../status.ts"
import { validateConfig } from "../config.ts"

test("設定ファイルがないときは、その旨と雛形の場所を返す", () => {
  const text = formatStatus({ status: "missing", path: "/repo/harness.config.json", examplePath: "/repo/harness.config.example.json" })
  assert.match(text, /harness\.config\.json/)
  assert.match(text, /\/repo\/harness\.config\.example\.json/)
})

test("設定が不正なときは、エラーを列挙する", () => {
  const text = formatStatus({ status: "invalid", path: "/repo/harness.config.json", errors: ["checks: 1 件以上必要です", "tests.globs: 1 件以上必要です"] })
  assert.match(text, /checks: 1 件以上必要です/)
  assert.match(text, /tests\.globs: 1 件以上必要です/)
})

test("設定が正しく、run がないときは「run はありません」と返す。警告があれば添える", () => {
  const { config, warnings } = validateConfig({
    models: { "dev.plan": ["openai/gpt-6-sol"] },
    checks: [{ name: "test", command: "npm test" }],
    tests: { globs: ["**/*.test.ts"] },
  })
  assert.ok(config)
  const text = formatStatus({ status: "ok", path: "/repo/harness.config.json", config, warnings })
  assert.match(text, /run はありません/)
  assert.match(text, /dev\.review\.spec/)
})
