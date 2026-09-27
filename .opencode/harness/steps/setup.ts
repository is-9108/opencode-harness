// setup の工程: issue を取得して保存し、issue 専用の worktree とブランチを用意し、依存をインストールして、ベースラインを取る（計画 5 章、8.2）
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import type { RecordInput, StepDeps, StepResult } from "../machine/dev.ts"
import { runIdFor, type RunState } from "../state.ts"
import { baseBranchOf } from "./common.ts"
import { readBaseline, recordBaseline } from "./baseline.ts"

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

  // 2. 依存先の issue の確認（worktree を作る前に。積むかどうかで起点が変わるため）
  const blocked = await checkDependencies(deps, run, issue.body)
  if (blocked) return blocked

  // 3. worktree とブランチ
  const branch = config.git.branch.replace("{issue}", String(run.issue)).replace("{slug}", slugify(issue.title))
  const worktreeRoot = resolve(root, config.git.worktreeRoot.replace("{repo}", basename(root)))
  const worktree = join(worktreeRoot, `issue-${run.issue}`)
  const ensured = await ensureWorktree(deps, worktree, branch, baseBranchOf(config, run))
  if (ensured) return ensured

  // 4. 依存のインストール（node_modules などは git の管理外なので、worktree には入っていない）
  if (config.setup.install) {
    const install = await deps.shell(config.setup.install, { cwd: worktree, timeoutSec: config.setup.timeoutSec })
    if (install.code !== 0 || install.timedOut) {
      const out = (install.stderr || install.stdout).trim().split(/\r?\n/).slice(-10).join("\n")
      const timedOut = install.timedOut ? "（タイムアウト）" : ""
      return { kind: "error", message: `worktree での依存のインストール（${config.setup.install}）に失敗しました${timedOut}:\n${out}` }
    }
  }

  // 5. 成果物のディレクトリは、それ自体の .gitignore で git の管理から外す
  const runDir = join(worktree, ".harness", "run")
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(worktree, ".harness", ".gitignore"), "*\n")

  // 6. ベースライン: 変更を加える前の checks の結果（#32）。再開のときは、変更後の結果を取らないように取り直さない
  if (!readBaseline(worktree)) {
    const baseline = await recordBaseline(deps, worktree)
    const failing = baseline.checks.filter((c) => !c.passed).map((c) => c.name)
    store.appendEvent(run.id, { type: "baseline.recorded", failing })
  }

  // 7. issue のスナップショット
  writeFileSync(join(runDir, "00-issue.md"), renderSnapshot(issue, deps.now?.() ?? new Date()))

  store.save({ ...run, step: "plan", title: issue.title, worktree, branch, pendingDependencies: undefined, stackCandidate: undefined })
  store.appendEvent(run.id, { type: "step.completed", step: "setup", worktree, branch })
  return { kind: "continue", message: `setup が完了しました。worktree: ${worktree}（ブランチ: ${branch}）。次の工程: plan` }
}

// 既存の worktree は再利用し、ブランチだけが残っていればそのブランチで作る。問題があれば StepResult を返す
async function ensureWorktree(deps: StepDeps, worktree: string, branch: string, base: string): Promise<StepResult | undefined> {
  const { root, exec } = deps
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
    : await git("worktree", "add", "-b", branch, worktree, base)
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


// ---- 依存先の issue の確認（計画 8.2 setup ①、#31） ----

// issue 本文の「依存関係」のセクションから、依存先の issue 番号を取り出す（自分自身は除く）
export function parseDependencies(body: string, self: number): number[] {
  const section = body.replace(/\r\n/g, "\n").match(/^##\s*依存関係\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m)?.[1] ?? ""
  const numbers = [...section.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1]))
  return [...new Set(numbers)].filter((n) => n !== self)
}

type GhDependency = { number: number; title: string; state: string }

// 依存先に開いている issue があり、ユーザーがまだ判断していなければ need_user を返す
async function checkDependencies(deps: StepDeps, run: RunState, body: string): Promise<StepResult | undefined> {
  if (run.dependencyDecision) return undefined
  const numbers = parseDependencies(body, run.issue)
  const open: GhDependency[] = []
  for (const n of numbers) {
    const view = await deps.exec("gh", ["issue", "view", String(n), "--json", "number,title,state"], { cwd: deps.root })
    if (view.code !== 0) return { kind: "error", message: `依存先の issue #${n} を取得できませんでした: ${view.stderr.trim()}` }
    const dep = JSON.parse(view.stdout) as GhDependency
    if (dep.state === "OPEN") open.push(dep)
  }
  if (!open.length) return undefined

  // 積めるのは、開いている依存先が 1 つで、そのブランチが見つかるときだけ
  const candidate = open.length === 1 ? await findDependencyBranch(deps, open[0]!.number) : undefined
  deps.store.save({ ...run, pendingDependencies: open.map((d) => d.number), stackCandidate: candidate })
  deps.store.appendEvent(run.id, { type: "dependency.open", open: open.map((d) => d.number), candidate })

  const list = open.map((d) => `- #${d.number} ${d.title}`).join("\n")
  const options = [
    "「待つ」: 依存先が閉じるまで止める（decision: wait）",
    ...(candidate ? [`「#${open[0]!.number} のブランチ ${candidate} の上に積む」: 依存先の変更を含めて開発する。PR の base も ${candidate} になる（decision: stack）`] : []),
    "「無視して進める」: ベースブランチから開発する（decision: ignore）",
  ]
  return {
    kind: "need_user",
    message: [
      `issue #${run.issue} の依存先に、まだ開いている issue があります。`,
      list,
      "",
      "手順: question ツールで、次の選択肢からユーザーに選んでもらい、harness_record（gate: dependency）で記録してください。",
      ...options.map((o) => `- ${o}`),
      ...(open.length === 1 && !candidate ? ["", `（#${open[0]!.number} のブランチが見つからないため、依存先のブランチの上で開発する選択肢はありません）`] : []),
    ].join("\n"),
  }
}

// 依存先の issue のブランチを探す。同じリポジトリの run のブランチ、なければ「Closes #N」がある開いた PR の head
async function findDependencyBranch(deps: StepDeps, issue: number): Promise<string | undefined> {
  const git = (...args: string[]) => deps.exec("git", args, { cwd: deps.root })
  const exists = async (branch: string) => (await git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).code === 0

  const fromRun = deps.store.get(runIdFor({ kind: "dev", issue }))?.branch
  if (fromRun && (await exists(fromRun))) return fromRun

  const list = await deps.exec("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName,body", "--limit", "100"], { cwd: deps.root })
  if (list.code !== 0) return undefined
  const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issue}\\b`, "i")
  const pr = (JSON.parse(list.stdout) as { headRefName: string; body: string }[]).find((p) => closes.test(p.body))
  if (!pr) return undefined
  await syncWithOrigin(deps, pr.headRefName)
  return (await exists(pr.headRefName)) ? pr.headRefName : undefined
}

// PR の head のブランチを origin から取り込む。依存先を別のマシンで開発していても積めるように。
// 手元になければ origin から作り、遅れていれば早送りする。手元のほうが進んでいれば、手元の作業を優先してそのままにする。
// fetch に失敗しても（オフラインなど）止めず、手元にあるものを使う
async function syncWithOrigin(deps: StepDeps, branch: string): Promise<void> {
  const git = (...args: string[]) => deps.exec("git", args, { cwd: deps.root })
  if ((await git("fetch", "--quiet", "origin", branch)).code !== 0) return
  const remote = `refs/remotes/origin/${branch}`
  if ((await git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).code !== 0) {
    await git("branch", "--quiet", "--track", branch, remote)
    return
  }
  const localIsBehind = (await git("merge-base", "--is-ancestor", `refs/heads/${branch}`, remote)).code === 0
  // 別の worktree で使われているブランチは動かせない（失敗したら手元のまま使う）
  if (localIsBehind) await git("branch", "--quiet", "--force", branch, remote)
}

// 依存先の確認への回答を記録する
export function recordDependency(deps: StepDeps, run: RunState, input: Extract<RecordInput, { gate: "dependency" }>): StepResult {
  if (run.step !== "setup" || !run.pendingDependencies?.length)
    return { kind: "error", message: `${run.id} は依存先の確認を待っていません（現在の工程: ${run.step}）` }
  const pending = run.pendingDependencies.map((n) => `#${n}`).join("、")
  deps.store.appendEvent(run.id, { type: "gate.recorded", gate: "dependency", decision: input.decision })

  switch (input.decision) {
    case "wait":
      // 判断は保存しない。次に /dev を実行したときに、もう一度依存先を確かめる
      deps.store.save({ ...run, pendingDependencies: undefined, stackCandidate: undefined })
      return { kind: "done", message: `依存先（${pending}）が閉じるまで待ちます。閉じたら、もう一度 /dev ${run.issue} を実行してください` }
    case "stack":
      if (!run.stackCandidate) return { kind: "error", message: `積む先のブランチが見つかりません。「待つ」か「無視して進める」を選んでください` }
      deps.store.save({ ...run, dependencyDecision: "stack", baseBranch: run.stackCandidate })
      return { kind: "continue", message: `${run.stackCandidate} の上に積んで開発します。harness_advance で setup を続けてください` }
    case "ignore":
      deps.store.save({ ...run, dependencyDecision: "ignore" })
      return { kind: "continue", message: `依存先（${pending}）を無視して、ベースブランチから開発します。harness_advance で setup を続けてください` }
  }
}
