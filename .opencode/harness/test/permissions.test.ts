import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { HARNESS_AGENTS, SECRET_DENY, filterGrepOutput, guardHarnessTool, isSecretPath } from "../permissions.ts"
import type { PermissionRule } from "../session.ts"

// エージェント定義の frontmatter の permission を、opencode と同じ順序のルールの列にする。
// 定義で使っている範囲の YAML（2 段の入れ子、引用符つきのキー、コメント）だけを読む
const agentRules = (name: string): PermissionRule[] => {
  const text = readFileSync(new URL(`../../agents/${name}.md`, import.meta.url), "utf8").replace(/\r\n/g, "\n")
  const front = text.split("\n---\n")[0]!.replace(/^---\n/, "")
  const lines = front.split("\n")
  const start = lines.findIndex((l) => l === "permission:")
  const rules: PermissionRule[] = []
  let current: string | undefined
  const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1")
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(" ")) break
    if (/^\s*#/.test(line) || !line.trim()) continue
    const nested = line.match(/^ {4}("[^"]*"|\S+):\s*(\S+)/)
    const top = line.match(/^ {2}(\S+):\s*(\S*)/)
    if (nested && current) rules.push({ permission: current, pattern: unquote(nested[1]!), action: nested[2] as PermissionRule["action"] })
    else if (top) {
      current = top[1]
      if (top[2]) rules.push({ permission: current!, pattern: "*", action: top[2] as PermissionRule["action"] })
    }
  }
  return rules
}

// opencode の評価: 対象に一致する最後のルールが勝つ。* は任意の文字列（パスの区切りを含む）
const matches = (pattern: string, target: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s").test(target)
const evaluate = (rules: PermissionRule[], permission: string, target: string) =>
  rules.findLast((r) => r.permission === permission && matches(r.pattern, target))?.action

// 工程が子セッションの作成時に渡す、いちばん広い許可（implementer / test-writer 相当）の後に、runChild が SECRET_DENY を付ける
const broadSession: PermissionRule[] = [
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "npx vitest*", action: "allow" },
  { permission: "bash", pattern: "npx tsc*", action: "allow" },
]
const WORKERS = ["dev-planner", "test-writer", "implementer", "reviewer", "pr-writer"]
const effective = (name: string) => [...agentRules(name), ...broadSession, ...SECRET_DENY]

test("作業用のエージェントは、git の書き込みを拒否され、読み取りは許可される（AC-1）", () => {
  for (const name of WORKERS) {
    const rules = effective(name)
    for (const cmd of ["git commit -m x", "git push origin HEAD", "git reset --hard HEAD~1", "git checkout main", "git switch -c x", "git stash", "git rebase main", "git merge x", "git clean -fd", "git -C x commit -m y"])
      assert.equal(evaluate(rules, "bash", cmd), "deny", `${name}: ${cmd}`)
    for (const cmd of ["git status", "git status --short", "git diff main...HEAD", "git log --oneline -5", "git show HEAD"])
      assert.equal(evaluate(rules, "bash", cmd), "allow", `${name}: ${cmd}`)
  }
})

test("作業用のエージェントは、依存の追加を拒否され、npm ci と引数なしの npm install は許可される（AC-2）", () => {
  for (const name of WORKERS) {
    const rules = effective(name)
    for (const cmd of ["npm install lodash", "npm i -D vitest", "npm install --save-dev x", "pnpm add x", "yarn add x", "pip install requests"])
      assert.equal(evaluate(rules, "bash", cmd), "deny", `${name}: ${cmd}`)
    for (const cmd of ["npm ci", "npm install"]) assert.equal(evaluate(rules, "bash", cmd), "allow", `${name}: ${cmd}`)
  }
})

test("作業用のエージェントは、webfetch・websearch と、.env や秘密鍵の読み書きを拒否される（AC-3）", () => {
  for (const name of WORKERS) {
    const rules = effective(name)
    assert.equal(evaluate(rules, "webfetch", "https://example.com"), "deny", name)
    assert.equal(evaluate(rules, "websearch", "query"), "deny", name)
    for (const file of ["C:\\work\\repo\\.env", "/work/repo/.env.local", "config/id_rsa", "certs/server.pem", "certs/server.key"]) {
      assert.equal(evaluate(rules, "read", file), "deny", `${name}: read ${file}`)
      assert.equal(evaluate(rules, "edit", file), "deny", `${name}: edit ${file}`)
    }
    assert.equal(evaluate(rules, "read", "/work/repo/.env.example"), "allow", name)
    assert.equal(evaluate(rules, "read", "/work/repo/src/slug.ts"), "allow", name)
  }
})

test("ハーネスのツールは、司令塔（harness）からだけ使える（AC-4）", () => {
  assert.deepEqual(HARNESS_AGENTS, ["harness"])
  assert.equal(guardHarnessTool("harness"), undefined)
  for (const agent of ["build", "plan", "general", "implementer", "Sisyphus - ultraworker"]) {
    const message = guardHarnessTool(agent)
    assert.ok(message, agent)
    assert.match(message, /harness/)
  }
})

// grep ツールの出力（opencode 1.18 の tool/grep.ts の形式）
const grepOutput = (files: [path: string, lines: string[]][], extra = "") =>
  [
    `Found ${files.reduce((n, [, l]) => n + l.length, 0)} matches${extra}`,
    ...files.flatMap(([p, lines], i) => [...(i ? [""] : []), `${p}:`, ...lines.map((l, j) => `  Line ${j + 1}: ${l}`)]),
  ].join("\n")

test("秘密情報のファイルのパスを判定する（.env.example は除く）", () => {
  for (const p of ["C:\\work\\repo\\.env", "/work/repo/.env.local", "config/id_rsa", "certs/server.pem", "certs/server.key"])
    assert.equal(isSecretPath(p), true, p)
  for (const p of ["/work/repo/.env.example", "C:\\work\\repo\\src\\env.ts", "src/keys.ts"]) assert.equal(isSecretPath(p), false, p)
})

test("grep の結果から、秘密情報のファイルの行を取り除き、件数を数え直す", () => {
  const out = grepOutput([
    ["C:\\work\\repo\\.env", ["API_TOKEN=secret"]],
    ["C:\\work\\repo\\src\\a.ts", ["const a = 1", "const b = 2"]],
    ["C:\\work\\repo\\.env.example", ["API_TOKEN="]],
  ])
  const filtered = filterGrepOutput(out)
  assert.doesNotMatch(filtered, /secret/)
  assert.ok(!filtered.includes("C:\\work\\repo\\.env:"))
  assert.match(filtered, /^Found 3 matches/)
  assert.ok(filtered.includes("C:\\work\\repo\\src\\a.ts:\n  Line 1: const a = 1\n  Line 2: const b = 2"))
  assert.ok(filtered.includes("C:\\work\\repo\\.env.example:\n  Line 1: API_TOKEN="))
  assert.match(filtered, /秘密情報.*1 件/)
})

test("秘密情報のファイルしか一致しなければ、一致なしとして返す", () => {
  const filtered = filterGrepOutput(grepOutput([["/work/repo/.env", ["API_TOKEN=secret"]]]))
  assert.doesNotMatch(filtered, /secret/)
  assert.match(filtered, /^No files found/)
})

test("秘密情報のファイルがなければ、grep の結果を変えない", () => {
  const out = grepOutput([["/work/repo/src/a.ts", ["const a = 1"]]], " (more matches available)")
  assert.equal(filterGrepOutput(out), out)
  assert.equal(filterGrepOutput("No files found"), "No files found")
})

