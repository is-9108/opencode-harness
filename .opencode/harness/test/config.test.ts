import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, validateConfig, CONFIG_FILE, EXAMPLE_FILE } from "../config.ts"

const minimal = () => ({
  models: {
    "dev.plan": ["opencode-go/kimi-k3", "openai/gpt-6-sol"],
    "dev.review.spec": ["openai/gpt-6-sol"],
    "dev.review.integrity": ["openai/gpt-6-luna"],
    "dev.review.advisory": ["openai/gpt-5.5"],
  },
  checks: [{ name: "test", command: "npm test", junit: "junit.xml" }],
  tests: { globs: ["**/*.test.ts"] },
})

const tempRoot = (config?: unknown, raw?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-config-"))
  if (raw !== undefined) writeFileSync(join(dir, CONFIG_FILE), raw)
  else if (config !== undefined) writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config))
  return dir
}

const errorsOf = (raw: unknown) => {
  const result = validateConfig(raw)
  assert.equal(result.config, undefined, "設定は不正として扱われるはず")
  return result.errors.join("\n")
}

test("設定ファイルがなければ missing を返し、雛形の場所を示す", () => {
  const dir = tempRoot()
  const result = loadConfig(dir)
  assert.equal(result.status, "missing")
  assert.equal(result.status === "missing" && result.examplePath, join(dir, EXAMPLE_FILE))
})

test("必須の項目だけの設定を読み込むと、残りは既定値で補完される", () => {
  const result = loadConfig(tempRoot(minimal()))
  assert.equal(result.status, "ok")
  if (result.status !== "ok") return
  const { config } = result
  assert.deepEqual(config.loops, { testFix: 3, reviewFix: 3, autoFixBudget: 6, reviewRoundsInHumanMode: 1, sameFingerprintLimit: 2 })
  assert.equal(config.context.compactAtTokens, 240000)
  assert.equal(config.tests.flakyRetries, 1)
  assert.deepEqual(config.providers.fallbackChain, ["opencode-go", "openai"])
  assert.deepEqual(config.review.perspectives.map((p) => p.name), ["spec", "test-integrity", "quality", "security", "performance"])
  assert.equal(config.checks[0]?.timeoutSec, 600)
})

test("一部だけ指定したセクションは、指定しなかったキーを既定値で補完する", () => {
  const result = validateConfig({ ...minimal(), loops: { testFix: 5 } })
  assert.equal(result.config?.loops.testFix, 5)
  assert.equal(result.config?.loops.reviewFix, 3)
})

test("JSON として壊れていれば invalid を返す", () => {
  const result = loadConfig(tempRoot(undefined, "{ \"models\": "))
  assert.equal(result.status, "invalid")
  assert.match(result.status === "invalid" ? result.errors.join() : "", /JSON/)
})

test("未知のキーはエラーにする（トップレベルとセクションの中）", () => {
  assert.match(errorsOf({ ...minimal(), modles: {} }), /modles/)
  assert.match(errorsOf({ ...minimal(), loops: { testFixx: 3 } }), /loops\.testFixx/)
})

test("advisory の観点に blocking: true を付けると、観点の名前つきでエラーにする", () => {
  const review = { perspectives: [{ name: "security", session: "advisory", blocking: true, rounds: "first" }] }
  assert.match(errorsOf({ ...minimal(), review }), /security/)
})

test("provider/model の形式でないモデル指定はエラーにする", () => {
  assert.match(errorsOf({ ...minimal(), models: { "dev.plan": ["gpt-5.5"] } }), /models\.dev\.plan/)
  assert.match(errorsOf({ ...minimal(), models: { "dev.plan": [] } }), /models\.dev\.plan/)
})

test("必須の項目が欠けている・空であればエラーにする", () => {
  const { checks, ...noChecks } = minimal()
  assert.match(errorsOf(noChecks), /checks/)
  assert.match(errorsOf({ ...minimal(), checks: [] }), /checks/)
  assert.match(errorsOf({ ...minimal(), tests: { globs: [] } }), /tests\.globs/)
  assert.match(errorsOf({ ...minimal(), checks: [{ name: "a", command: "x" }, { name: "a", command: "y" }] }), /重複/)
})

test("数値の項目に不正な値を入れるとエラーにする", () => {
  assert.match(errorsOf({ ...minimal(), loops: { testFix: 0 } }), /loops\.testFix/)
  assert.match(errorsOf({ ...minimal(), budget: { warnAtRatio: 1.5 } }), /budget\.warnAtRatio/)
})

test("観点が参照するモデルのキーが models にないときは、エラーではなく警告にする", () => {
  const { "dev.review.integrity": _, ...models } = minimal().models
  const result = validateConfig({ ...minimal(), models })
  assert.ok(result.config)
  assert.match(result.warnings.join(), /dev\.review\.integrity/)
})

test("リポジトリの harness.config.example.json は、そのまま有効な設定である", () => {
  const example = JSON.parse(readFileSync(new URL("../../../harness.config.example.json", import.meta.url), "utf8"))
  const result = validateConfig(example)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
})
