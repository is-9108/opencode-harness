// harness-fix（/fix の司令塔）の編集とコマンドの制限（計画 8.6、9 章、#41）。
// 子セッションと違い、司令塔のセッションには作成時に権限を渡せないため、プラグインのフックで拒否する。
// エージェント定義では編集を許可し、ここでテストファイル・ハーネスの成果物・秘密情報への編集を止める
import type { HarnessConfig } from "./config.ts"
import { isSecretPath } from "./permissions.ts"
import { globToRegExp } from "./testing/lock.ts"

export const FIX_AGENT = "harness-fix"

// 編集のツールと、引数のパス
const EDIT_TOOLS = new Set(["edit", "write", "multiedit"])
const PATCH_TOOLS = new Set(["patch", "apply_patch"])

// 成果物（.harness/）のうち、harness-fix が書いてよいもの: 修正の記録と、テストの変更申請
const WRITABLE_ARTIFACTS = [/(^|\/)\.harness\/run\/fix-\d+\.md$/, /(^|\/)\.harness\/run\/change-requests\/test-\d+\.md$/]

const normalize = (p: string) => p.replace(/\\/g, "/")

// パスの末尾の部分（c.ts、b/c.ts、a/b/c.ts …）のどれかがテストの glob に一致するか。
// 絶対パスでも worktree からの相対パスでも判定できるよう、広めに一致させる（拒否する側に倒す）
export function isTestPath(path: string, globs: string[]): boolean {
  const parts = normalize(path).split("/").filter(Boolean)
  const patterns = globs.map(globToRegExp)
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join("/")
    if (patterns.some((p) => p.test(suffix))) return true
  }
  return false
}

// 編集のツールで触るパス
export function editedPaths(tool: string, args: Record<string, unknown> | undefined): string[] {
  if (!args) return []
  if (EDIT_TOOLS.has(tool)) return typeof args.filePath === "string" ? [args.filePath] : []
  if (PATCH_TOOLS.has(tool)) {
    const text = [args.patchText, args.patch, args.input].find((v) => typeof v === "string") as string | undefined
    return text ? [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm), ...text.matchAll(/^\*\*\* Move to: (.+)$/gm)].map((m) => m[1]!.trim()) : []
  }
  return []
}

// harness-fix のツール呼び出しを拒否する理由。拒否しなければ undefined
export function fixEditDenial(config: HarnessConfig, tool: string, args: Record<string, unknown> | undefined): string | undefined {
  for (const path of editedPaths(tool, args)) {
    const p = normalize(path)
    if (isTestPath(p, config.tests.globs))
      return `テストファイル（${path}）は編集できません（ロックされています）。テストの変更が必要なら、変更申請（.harness/run/change-requests/test-<番号>.md）を書いてください`
    if (/(^|\/)\.harness\//.test(p) && !WRITABLE_ARTIFACTS.some((re) => re.test(p)))
      return `ハーネスの成果物（${path}）は編集できません。書けるのは、修正の記録（fix-<番号>.md）とテストの変更申請だけです`
    if (isSecretPath(p)) return `秘密情報のファイル（${path}）は編集できません`
  }
  return undefined
}

// 確認なしで実行してよいコマンド（checks のコマンドと、git の読み取り）。それ以外はエージェント定義どおりに確認する。
// worktree はリポジトリの外にあるので、「cd <worktree> && <コマンド>」と「git -C <worktree> …」の形も認める
export function isAllowedFixCommand(config: HarnessConfig, command: string): boolean {
  let c = command.trim()
  const cd = c.match(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*(.+)$/s)
  if (cd) {
    if (!/\.worktrees/.test(cd[1]!)) return false
    c = cd[2]!.trim()
  }
  if (config.checks.some((check) => c === check.command.trim())) return true
  if (/[;&|`$<>]/.test(c)) return false // つないだコマンドやリダイレクトは、確認に回す
  return /^git (-C\s+("[^"]+"|\S+)\s+)?(status|diff|log|show)\b/.test(c)
}
