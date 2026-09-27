// テストのロック（計画 8.2「テストのロックの守り方」）
// 1. 権限: 実装役の子セッションに、tests.globs のファイルの編集を拒否するルールを渡す
// 2. 監査: 工程が終わるたびにハッシュを照合し、変わっていれば red のチェックポイントから戻す
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import type { Exec } from "../exec.ts"
import type { PermissionRule } from "../session.ts"

export type TestLock = { commit: string; files: Record<string, string> }
export type LockChange = { file: string; kind: "modified" | "deleted" | "added" }
export type LockAudit = { ok: boolean; changes: LockChange[] }

const LOCK_FILE = join(".harness", "run", "test-lock.json")
// テストの対象から外すディレクトリ（依存、ハーネスの成果物、ハーネス自身、git）
const SKIP_DIRS = new Set(["node_modules", ".git", ".harness", ".opencode"])

export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === "*" && glob[i + 1] === "*") {
      // 「**/」は 0 個以上のディレクトリ、末尾などの「**」は何でも
      if (glob[i + 2] === "/") (re += "(?:.*/)?"), (i += 2)
      else (re += ".*"), (i += 1)
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

// worktree の中で tests.globs に一致するファイルを、/ 区切りの相対パスで返す
export function listTestFiles(worktree: string, globs: string[]): string[] {
  const patterns = globs.map(globToRegExp)
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
      } else if (entry.isFile()) {
        const rel = relative(worktree, full).split(sep).join("/")
        if (patterns.some((p) => p.test(rel))) found.push(rel)
      }
    }
  }
  walk(worktree)
  return found.sort()
}

// 改行コードを LF にそろえてからハッシュを取る（Windows の CRLF 変換で変更と誤検知しないため）
function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).digest("hex")
}

export function createLock(worktree: string, globs: string[], commit: string): TestLock {
  const files: Record<string, string> = {}
  for (const rel of listTestFiles(worktree, globs)) files[rel] = hashFile(join(worktree, rel))
  const lock = { commit, files }
  writeFileSync(join(worktree, LOCK_FILE), JSON.stringify(lock, null, 2))
  return lock
}

export function readLock(worktree: string): TestLock | undefined {
  const path = join(worktree, LOCK_FILE)
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as TestLock) : undefined
}

// ロックと照合し、変更・削除されたファイルはロック時の commit から戻し、追加されたファイルは取り除く
export async function auditLock(exec: Exec, worktree: string, globs: string[]): Promise<LockAudit> {
  const lock = readLock(worktree)
  if (!lock) return { ok: true, changes: [] }
  const changes: LockChange[] = []
  for (const [file, hash] of Object.entries(lock.files)) {
    const path = join(worktree, file)
    if (!existsSync(path)) changes.push({ file, kind: "deleted" })
    else if (hashFile(path) !== hash) changes.push({ file, kind: "modified" })
  }
  for (const file of listTestFiles(worktree, globs)) if (!(file in lock.files)) changes.push({ file, kind: "added" })

  const restore = changes.filter((c) => c.kind !== "added").map((c) => c.file)
  if (restore.length > 0) {
    const r = await exec("git", ["checkout", lock.commit, "--", ...restore], { cwd: worktree })
    if (r.code !== 0) throw new Error(`テストファイルを元に戻せませんでした: ${r.stderr.trim()}`)
  }
  for (const c of changes.filter((c) => c.kind === "added")) rmSync(join(worktree, c.file), { force: true })
  return { ok: changes.length === 0, changes }
}

// 権限のパターンの * はパスの区切りもまたぐので、glob の ** を * に置き換える（例: **/*.test.ts → *.test.ts）
export function lockPermissions(globs: string[]): PermissionRule[] {
  return globs.map((g) => ({
    permission: "edit",
    pattern: g.replace(/(^|\/)\*\*\//g, "$1*").replace(/\*+/g, "*"),
    action: "deny" as const,
  }))
}
