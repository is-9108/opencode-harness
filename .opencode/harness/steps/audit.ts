// テストのロックの照合（#12）。ロックしたテストファイルが変わっていたら元に戻し、その工程を失敗として扱う
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import { auditLock } from "../testing/lock.ts"
import { runDir } from "./common.ts"

// 工程の後に照合する。問題がなければ工程の結果をそのまま返す
export async function auditAfterStep(deps: StepDeps, run: RunState, result: StepResult): Promise<StepResult> {
  return (await enforceLock(deps, run)) ?? result
}

// 照合して、変更があれば元に戻して記録し、工程を進めずに失敗の結果を返す。変更がなければ undefined
// commit する工程（green など）は、commit の前にこれを呼び、改ざんされたテストを commit に入れないようにする
export async function enforceLock(deps: StepDeps, run: RunState): Promise<StepResult | undefined> {
  const worktree = run.worktree ?? ""
  const audit = await auditLock(deps.exec, worktree, deps.config.tests.globs)
  if (audit.ok) return undefined

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
