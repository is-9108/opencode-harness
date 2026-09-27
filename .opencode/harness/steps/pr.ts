// pr の工程（計画 8.2）。pr-writer にテンプレートに沿った本文を書かせ、ハーネスが push して PR を作る。
// 同じブランチの PR がすでにあれば、作らずに本文を更新する（再実行しても PR が重複しない）
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readFrontmatter } from "../artifacts.ts"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import { baseChildPermissions, editOnly, readTemplate, runDir } from "./common.ts"
import { planPath } from "./plan.ts"

const MODEL_KEY = "dev.pr"
const BODY_FILE = "pr-body.md"
const LARGE_DIFF_LINES = 300
const HEADING = /^## .+$/gm

export async function runPr(deps: StepDeps, run: RunState): Promise<StepResult> {
  const worktree = run.worktree
  const branch = run.branch
  if (!worktree || !branch) return { kind: "error", message: "worktree とブランチが記録されていません。setup からやり直してください" }
  const model = deps.config.models[MODEL_KEY]?.[0]
  if (!model) return { kind: "error", message: `harness.config.json の models に「${MODEL_KEY}」がありません` }

  const template = readTemplate("github/pull_request_template.md")
  const sections = template.match(HEADING) ?? []
  const bodyPath = join(runDir(worktree), BODY_FILE)
  const common = {
    runId: run.id,
    directory: worktree,
    title: `${run.id}: pr`,
    agent: "pr-writer",
    model,
    permission: [...baseChildPermissions(worktree), ...editOnly(BODY_FILE)],
  }

  // 1. 本文を書かせる。不足は同じセッションに 1 回だけ直させる
  const first = await deps.child({ ...common, prompt: writePrompt(deps, run, worktree, bodyPath, template) })
  if (first.status !== "completed") return childFailed(first)
  let problems = validate(readIfExists(bodyPath), sections, run.issue)
  if (problems.length > 0) {
    const retry = await deps.child({ ...common, sessionID: first.sessionID, prompt: fixPrompt(bodyPath, problems) })
    if (retry.status !== "completed") return childFailed(retry)
    problems = validate(readIfExists(bodyPath), sections, run.issue)
    if (problems.length > 0) return { kind: "error", message: [`PR の本文が不完全です（${bodyPath}）:`, ...problems.map((p) => `- ${p}`)].join("\n") }
  }

  // 2. 投稿する本文を組み立てる（frontmatter を除き、差分が大きければ警告を先頭に、ハーネスの記録を末尾に足す）
  const raw = readFileSync(bodyPath, "utf8")
  const title = unquote(readFrontmatter(raw).title ?? "")
  const diffLines = await countDiffLines(deps, worktree)
  const finalBody = [
    ...(diffLines > LARGE_DIFF_LINES ? [`> [!WARNING]`, `> 差分が ${diffLines} 行あり、目安の ${LARGE_DIFF_LINES} 行を超えています。issue の分割を検討してください。`, ""] : []),
    stripFrontmatter(raw).trim(),
    "",
    harnessRecord(deps, run, diffLines),
  ].join("\n")
  const finalPath = join(runDir(worktree), "pr-body.final.md")
  writeFileSync(finalPath, finalBody)

  // 3. push して、PR を作るか更新する
  const git = (...args: string[]) => deps.exec("git", args, { cwd: worktree })
  const gh = (...args: string[]) => deps.exec("gh", args, { cwd: worktree })
  const push = await git("push", "-u", "origin", branch)
  if (push.code !== 0) return { kind: "error", message: `push に失敗しました: ${push.stderr.trim()}` }

  const listed = await gh("pr", "list", "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1")
  if (listed.code !== 0) return { kind: "error", message: `既存の PR を確認できませんでした: ${listed.stderr.trim()}` }
  const existing = (JSON.parse(listed.stdout || "[]") as { number: number; url: string }[])[0]
  let pr: { number: number; url: string }
  if (existing) {
    const edit = await gh("pr", "edit", String(existing.number), "--title", title, "--body-file", finalPath)
    if (edit.code !== 0) return { kind: "error", message: `PR #${existing.number} を更新できませんでした: ${edit.stderr.trim()}` }
    pr = existing
  } else {
    const create = await gh("pr", "create", "--base", deps.config.git.baseBranch, "--head", branch, "--title", title, "--body-file", finalPath)
    if (create.code !== 0) return { kind: "error", message: `PR を作れませんでした: ${create.stderr.trim()}` }
    const url = create.stdout.trim().split(/\s+/).at(-1) ?? ""
    pr = { number: Number(url.split("/").at(-1)), url }
  }

  const latest = deps.store.get(run.id) ?? run
  deps.store.save({ ...latest, step: "done", status: "done", prNumber: pr.number, prUrl: pr.url })
  deps.store.appendEvent(run.id, { type: "pr.published", number: pr.number, url: pr.url, updated: Boolean(existing), diffLines })
  return { kind: "done", message: `${existing ? "PR を更新しました" : "PR を作成しました"}: ${pr.url}（差分 ${diffLines} 行）。run ${run.id} は完了です` }
}

function validate(content: string, sections: string[], issue: number): string[] {
  const problems: string[] = []
  const fm = readFrontmatter(content)
  if (fm.status !== "done") problems.push("frontmatter が status: done になっていません")
  if (!unquote(fm.title ?? "")) problems.push("frontmatter に title がありません")
  const body = stripFrontmatter(content)
  for (const s of sections) {
    const i = body.indexOf(s)
    if (i < 0) {
      problems.push(`見出し「${s}」がありません`)
      continue
    }
    const rest = body.slice(i + s.length)
    const next = rest.search(/^## /m)
    const text = (next < 0 ? rest : rest.slice(0, next)).replace(/<!--[\s\S]*?-->/g, "").trim()
    if (!text) problems.push(`「${s}」が空です（該当がなければ「なし」と書く）`)
  }
  if (!new RegExp(`Closes #${issue}\\b`).test(body)) problems.push(`本文に「Closes #${issue}」がありません`)
  return problems
}

async function countDiffLines(deps: StepDeps, worktree: string): Promise<number> {
  const r = await deps.exec("git", ["diff", "--numstat", `${deps.config.git.baseBranch}...HEAD`, "--", ".", ":(exclude).opencode"], { cwd: worktree })
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.split("\t"))
    .reduce((sum, [a, d]) => sum + (Number(a) || 0) + (Number(d) || 0), 0)
}

// events.jsonl の子セッションの記録を集計する（トークン数は LLM ではなくハーネスが数える）
function harnessRecord(deps: StepDeps, run: RunState, diffLines: number): string {
  const path = join(deps.root, ".harness", "runs", run.id, "events.jsonl")
  const children = (existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [])
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; title?: string; agent?: string; model?: string; durationMs?: number; tokens?: { total?: number } })
    .filter((e) => e.type === "child.completed")
  const n = (v: number) => v.toLocaleString("en-US")
  const total = children.reduce((s, e) => s + (e.tokens?.total ?? 0), 0)
  return [
    "## ハーネスの記録",
    "",
    "| 工程 | エージェント | モデル | トークン | 時間 |",
    "|---|---|---|---|---|",
    ...children.map((e) => `| ${e.title ?? ""} | ${e.agent ?? ""} | ${e.model ?? ""} | ${n(e.tokens?.total ?? 0)} | ${Math.round((e.durationMs ?? 0) / 1000)} 秒 |`),
    "",
    `- トークンの合計: ${n(total)}`,
    `- checks: ${run.checksRuns ?? 0} 回、review: ${run.reviewRounds ?? 0} 回、差分: ${diffLines} 行`,
    "",
    "🤖 opencode ハーネスで作成",
  ].join("\n")
}

function writePrompt(deps: StepDeps, run: RunState, worktree: string, bodyPath: string, template: string): string {
  const dir = runDir(worktree)
  return [
    `issue #${run.issue} の実装の PR 本文を書いてください。`,
    "",
    "材料:",
    `- issue: ${join(dir, "00-issue.md")}`,
    `- 計画: ${planPath(worktree)}`,
    `- テストの記録: ${join(dir, "02-red.md")}、${join(dir, "03-green-log.md")}`,
    `- checks の結果: ${join(dir, "checks", `run-${run.checksRuns ?? 1}.md`)}`,
    `- レビューの集計: ${join(dir, "reviews", `round-${run.reviewRounds ?? 1}`, "summary.md")}`,
    `- 差分: git diff ${deps.config.git.baseBranch}...HEAD -- . ":(exclude).opencode"（ハーネス自身の .opencode/ の変更は PR の説明に含めない）`,
    "",
    `出力先: ${bodyPath}（このファイル以外は編集できない）。「関連 issue」には「Closes #${run.issue}」と書く。`,
    "",
    "テンプレート:",
    "```markdown",
    template.trim(),
    "```",
  ].join("\n")
}

function fixPrompt(bodyPath: string, problems: string[]): string {
  return [`PR の本文（${bodyPath}）に次の不足があります。直してください。`, ...problems.map((p) => `- ${p}`), "", "直し終えたら frontmatter を status: done にすること。"].join("\n")
}

function childFailed(result: { status: "error" | "aborted"; error?: string }): StepResult {
  if (result.status === "aborted") return { kind: "error", message: "pr の子セッションが中断されました。harness_advance で再開できます" }
  return { kind: "error", message: `pr の子セッションがエラーで終わりました: ${result.error}` }
}

const stripFrontmatter = (s: string) => s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1")
const readIfExists = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
