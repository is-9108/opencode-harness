import { test } from "node:test"
import assert from "node:assert/strict"
import { readFrontmatter, setFrontmatter } from "../artifacts.ts"

test("frontmatter の key: value を読む。空白の後の # 以降はコメントとして取り除く", () => {
  const fm = readFrontmatter("---\nstatus: draft   # 完成したら done\nissue: 12\n---\n# 本文\n")
  assert.deepEqual(fm, { status: "draft", issue: "12" })
})

test("値の中の # は、前に空白がなければコメントにしない。引用符の中もコメントにしない", () => {
  const fm = readFrontmatter('---\ntitle: "feat: slug を追加 (#7)"\nref: issue#7\nquoted: "a # b"\n---\n')
  assert.equal(fm.title, '"feat: slug を追加 (#7)"')
  assert.equal(fm.ref, "issue#7")
  assert.equal(fm.quoted, '"a # b"')
})

test("frontmatter がなければ空のオブジェクトを返す", () => {
  assert.deepEqual(readFrontmatter("# 本文だけ\n"), {})
})

test("項目を書き換え、なければ足す。frontmatter がなければ作る", () => {
  assert.match(setFrontmatter("---\napproved: false\n---\n本文\n", "approved", "true"), /^---\napproved: true\n---\n本文/)
  assert.match(setFrontmatter("---\nstatus: done\n---\n", "approved", "true"), /status: done\napproved: true/)
  assert.match(setFrontmatter("本文\n", "status", "done"), /^---\nstatus: done\n---\n本文/)
})

test("「key:」の次の行から続く「  - item」のリストは、「, 」でつないだ値として読む", () => {
  const text = "---\nstatus: pending\ntests:\n  - src/a.test.ts\n  - \"src/b.test.ts\"\nac:\n  - AC-3\nnote: x\n---\n本文\n"
  const fm = readFrontmatter(text)
  assert.equal(fm.tests, "src/a.test.ts, src/b.test.ts")
  assert.equal(fm.ac, "AC-3")
  assert.equal(fm.note, "x")
  assert.equal(fm.status, "pending")
})
