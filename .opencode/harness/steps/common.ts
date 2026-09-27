// 工程に共通するパスと、子セッションに渡す権限
import { readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { HarnessConfig } from "../config.ts"
import type { PermissionRule } from "../session.ts"
import type { RunState } from "../state.ts"

export const runDir = (worktree: string) => join(worktree, ".harness", "run")
export const gatesDir = (worktree: string) => join(runDir(worktree), "gates")

// 差分と PR の base の基準になるブランチ。依存先の issue のブランチに積んだ run では、そのブランチ（#31）
export const baseBranchOf = (config: HarnessConfig, run: RunState) => run.baseBranch ?? config.git.baseBranch

// ハーネスに同梱した雛形を読む（.opencode/templates/）
export const readTemplate = (relative: string) => readFileSync(new URL(`../../templates/${relative}`, import.meta.url), "utf8")

// 子セッションに共通の権限。worktree はリポジトリの外にあるので external_directory を許可する（M0-7）。
// パスの表記が揺れることがあったため、完全なパスではなく worktree の親ディレクトリ名のワイルドカードで許可する
export function baseChildPermissions(worktree: string): PermissionRule[] {
  return [
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: `*${basename(dirname(worktree))}*`, action: "allow" },
    { permission: "question", pattern: "*", action: "deny" },
  ]
}

// 指定したファイル名だけを編集できるようにする（パスの区切り文字に依存しないよう、末尾で照合する）
export function editOnly(...fileNames: string[]): PermissionRule[] {
  return [
    { permission: "edit", pattern: "*", action: "deny" },
    ...fileNames.map((f) => ({ permission: "edit", pattern: `*${f}`, action: "allow" as const })),
  ]
}
