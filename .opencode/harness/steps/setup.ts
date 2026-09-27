// setup の工程: issue を取得して保存し、issue 専用の worktree とブランチを用意する（計画 5 章、8.2）
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"

const SLUG_MAX = 40

type GhIssue = { number: number; title: string; body: string; state: string; url: string }

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "")
  return slug || "issue"
}

export async function runSetup(deps: StepDeps, run: RunState): Promise<StepResult> {
  const { root, config, exec, store } = deps

  // 1. issue を取得する（worktree を作る前に確かめ、失敗したら何も作らない）
  const view = await exec("gh", ["issue", "view", String(run.issue), "--json", "number,title,body,state,url"], { cwd: root })
  if (view.code !== 0) return { kind: "error", message: `issue #${run.issue} を取得できませんでした: ${view.stderr.trim()}` }
  const issue = JSON.parse(view.stdout) as GhIssue
  if (issue.state !== "OPEN") return { kind: "error", message: `issue #${run.issue} は閉じています（${issue.state}）。開いている issue だけを開発できます` }

  // 2. worktree とブランチ
  const branch = config.git.branch.replace("{issue}", String(run.issue)).replace("{slug}", slugify(issue.title))
  const worktreeRoot = resolve(root, config.git.worktreeRoot.replace("{repo}", basename(root)))
  const worktree = join(worktreeRoot, `issue-${run.issue}`)
  const ensured = await ensureWorktree(deps, worktree, branch)
  if (ensured) return ensured

  // 3. issue のスナップショット。成果物のディレクトリは、それ自体の .gitignore で git の管理から外す
  const runDir = join(worktree, ".harness", "run")
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(worktree, ".harness", ".gitignore"), "*\n")
  writeFileSync(join(runDir, "00-issue.md"), renderSnapshot(issue, deps.now?.() ?? new Date()))

  store.save({ ...run, step: "plan", title: issue.title, worktree, branch })
  store.appendEvent(run.id, { type: "step.completed", step: "setup", worktree, branch })
  return { kind: "continue", message: `setup が完了しました。worktree: ${worktree}（ブランチ: ${branch}）。次の工程: plan` }
}

// 既存の worktree は再利用し、ブランチだけが残っていればそのブランチで作る。問題があれば StepResult を返す
async function ensureWorktree(deps: StepDeps, worktree: string, branch: string): Promise<StepResult | undefined> {
  const { root, config, exec } = deps
  const git = (...args: string[]) => exec("git", args, { cwd: root })

  const listed = parseWorktreeList((await git("worktree", "list", "--porcelain")).stdout).find((w) => samePath(w.path, worktree))
  if (listed) {
    if (listed.branch === branch) return undefined
    return { kind: "error", message: `worktree ${worktree} は別のブランチ（${listed.branch ?? "detached"}）になっています。想定しているブランチ: ${branch}` }
  }
  if (existsSync(worktree) && readdirSync(worktree).length > 0)
    return { kind: "error", message: `worktree を作る場所 ${worktree} に、git の worktree ではないファイルがあります。移動または削除してから、もう一度実行してください` }

  const branchExists = (await git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).code === 0
  const add = branchExists
    ? await git("worktree", "add", worktree, branch)
    : await git("worktree", "add", "-b", branch, worktree, config.git.baseBranch)
  if (add.code !== 0) return { kind: "error", message: `worktree を作れませんでした: ${add.stderr.trim()}` }
  return undefined
}

function parseWorktreeList(porcelain: string): { path: string; branch?: string }[] {
  return porcelain
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const path = block.match(/^worktree (.+)$/m)?.[1]
      const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]
      return path ? { path, branch } : undefined
    })
    .filter((w): w is { path: string; branch: string | undefined } => w !== undefined)
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "")
    return process.platform === "win32" ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

function renderSnapshot(issue: GhIssue, fetchedAt: Date): string {
  const sha = createHash("sha256").update(issue.body).digest("hex")
  return [
    "---",
    `issue: ${issue.number}`,
    `title: ${JSON.stringify(issue.title)}`,
    `url: ${issue.url}`,
    `state: ${issue.state}`,
    `bodySha256: ${sha}`,
    `fetchedAt: ${fetchedAt.toISOString()}`,
    "---",
    "",
    `# #${issue.number} ${issue.title}`,
    "",
    issue.body,
    "",
  ].join("\n")
}
