// 工程の後のテストの監査（#12）。ロックしたテストファイルが変わっていたら元に戻し、その工程を失敗として扱う
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import { auditLock } from "../testing/lock.ts"
import { runDir } from "./common.ts"

export async function auditAfterStep(deps: StepDeps, run: RunState, result: StepResult): Promise<StepResult> {
  const worktree = run.worktree ?? ""
  const audit = await auditLock(deps.exec, worktree, deps.config.tests.globs)
  if (audit.ok) return result

  const at = (deps.now?.() ?? new Date()).toISOString()
  const lines = audit.changes.map((c) => `| ${at} | ${run.step} | ${c.kind} | ${c.file} |`)
  appendFileSync(join(runDir(worktree), "test-audit.md"), lines.join("\n") + "\n")
  deps.store.appendEvent(run.id, { type: "lock.violated", step: run.step, changes: audit.changes })
  // 工程は進めない（その工程を失敗として扱う）
  const latest = deps.store.get(run.id)
  if (latest) deps.store.save({ ...latest, step: run.step })
  return {
    kind: "error",
    message: [
      `工程 ${run.step} の間に、ロックしたテストファイルが変更されていたので、red のチェックポイントの内容に元に戻しました:`,
      ...audit.changes.map((c) => `- ${c.kind}: ${c.file}`),
      "この工程は失敗として扱います。テストを変えずに実装だけで通すよう、もう一度進めてください。",
    ].join("\n"),
  }
}
