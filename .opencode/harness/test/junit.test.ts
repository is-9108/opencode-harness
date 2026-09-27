import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parseJUnit } from "../testing/junit.ts"

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

test("vitest の JUnit から、テストごとの名前・ファイル・結果・失敗の種類とメッセージを取り出す", () => {
  const cases = parseJUnit(fixture("vitest-mixed.junit.xml"))
  assert.equal(cases.length, 6)
  const tc01 = cases.find((c) => c.name.includes("[TC-01]"))
  assert.deepEqual(tc01 && { file: tc01.file, status: tc01.status, failureType: tc01.failureType, loadError: tc01.loadError }, {
    file: "src/slug.test.ts",
    status: "failed",
    failureType: "AssertionError",
    loadError: false,
  })
  // 名前の実体参照は元に戻す
  assert.equal(tc01?.name, "slugify > [TC-01] 空白をハイフンにする")
  assert.equal(tc01?.message, "expected 'a b' to be 'a-b' // Object.is equality")

  const passed = cases.find((c) => c.name.includes("既存のテスト"))
  assert.equal(passed?.status, "passed")
})

test("テストファイルを読み込めなかった場合（import エラー・構文エラー）は loadError として区別する", () => {
  const cases = parseJUnit(fixture("vitest-mixed.junit.xml"))
  const load = cases.filter((c) => c.loadError).map((c) => c.file).sort()
  assert.deepEqual(load, ["src/broken-import.test.ts", "src/syntax.test.ts"])
})

test("メッセージから端末の色の制御文字を取り除く", () => {
  const syntax = parseJUnit(fixture("vitest-mixed.junit.xml")).find((c) => c.file === "src/syntax.test.ts")
  assert.ok(syntax?.message?.includes("PARSE_ERROR"))
  assert.doesNotMatch(syntax?.message ?? "", /\x1b\[/)
})

test("自己終了タグの testcase、skipped、error も扱う", () => {
  const xml = `<testsuites><testsuite name="a">
    <testcase classname="a.test.ts" name="ok"/>
    <testcase classname="a.test.ts" name="skip"><skipped/></testcase>
    <testcase classname="a.test.ts" name="boom"><error message="kaboom" type="Error">stack</error></testcase>
  </testsuite></testsuites>`
  assert.deepEqual(
    parseJUnit(xml).map((c) => [c.name, c.status, c.message ?? null]),
    [["ok", "passed", null], ["skip", "skipped", null], ["boom", "failed", "kaboom"]],
  )
})
