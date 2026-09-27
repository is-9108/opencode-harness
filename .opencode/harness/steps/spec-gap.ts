// spec_gap（仕様の曖昧さ・抜け）への対応（計画 8.4 のループ条件、#38）。
// レビューで spec_gap が出たら、ループの回数に数えずに、司令塔が question でユーザーに解釈を聞く。
// 回答は 04-decisions.md に記録して、次のレビューと review-fix の入力にする。issue へのコメントは下書きまで（投稿はしない）
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RecordInput, StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState, SpecGap } from "../state.ts"
import { runDir } from "./common.ts"
import { afterReviewBlocking } from "./review.ts"

export const decisionsPath = (worktree: string) => join(runDir(worktree), "04-decisions.md")
export const commentDraftPath = (worktree: string) => join(runDir(worktree), "issue-comment-draft.md")

// 「解釈1: … / 解釈2: …」の形で書かれた、解釈の選択肢
export function parseOptions(content: string): string[] {
  return content
    .split(/解釈\s*\d+\s*[:：]/)
    .slice(1)
    .map((o) => o.trim().replace(/\s*[/／]\s*$/, "").trim())
    .filter(Boolean)
}

// 答えていない spec_gap があれば、1 件ずつ聞く。すべて答えたら、review-fix に進むか、決まった解釈でレビューし直す
export async function runSpecGap(deps: StepDeps, run: RunState): Promise<StepResult> {
  const next = run.pendingSpecGaps?.[0]
  if (next) return question(run, next)

  const followUp = run.specGapFollowUp
  const cleared = { ...run, pendingSpecGaps: undefined, specGapFollowUp: undefined }
  if (followUp && followUp.blocking.length > 0) {
    deps.store.save(cleared)
    return afterReviewBlocking(deps, cleared, followUp.blocking, followUp.recurred, followUp.summary)
  }
  // blocking がなければ、決まった解釈に実装が合っているかを、差分の全体でレビューし直す（前回からの差分だけでは足りない）
  deps.store.save({ ...cleared, step: "review", reviewedCommit: undefined })
  return { kind: "continue", message: "仕様の確認がすべて終わりました。決まった解釈で、もう一度レビューします。次の工程: review" }
}

export function recordSpecGap(deps: StepDeps, run: RunState, input: Extract<RecordInput, { gate: "spec_gap" }>): StepResult {
  const gap = run.pendingSpecGaps?.[0]
  if (run.step !== "spec-gap" || !gap) return { kind: "error", message: `${run.id} は仕様の確認（spec_gap）への回答を待っていません` }
  const answer = input.feedback?.trim()
  if (!answer) return { kind: "error", message: "回答（feedback）が空です。ユーザーが選んだ解釈、または自由に書いた回答を feedback に入れてください" }
  const worktree = run.worktree ?? ""
  const at = (deps.now?.() ?? new Date()).toISOString()
  const number = (run.answeredGaps?.length ?? 0) + 1

  appendDecision(worktree, number, gap, answer, at)
  appendCommentDraft(worktree, run.issue, gap, answer)
  const rest = run.pendingSpecGaps!.slice(1)
  const latest = { ...run, pendingSpecGaps: rest, answeredGaps: [...(run.answeredGaps ?? []), gap.key] }
  deps.store.save(latest)
  deps.store.appendEvent(run.id, { type: "gate.recorded", gate: "spec_gap", decision: "answered", key: gap.key, number })

  if (rest.length > 0) return question(latest, rest[0]!, `回答を ${decisionsPath(worktree)} に記録しました。続けて、次の点を確認してください。\n\n`)
  return { kind: "continue", message: `回答を ${decisionsPath(worktree)} に記録しました（issue へのコメントの下書き: ${commentDraftPath(worktree)}。投稿はしていません）。harness_advance で続けます` }
}

function question(run: RunState, gap: SpecGap, lead = ""): StepResult {
  const remaining = run.pendingSpecGaps?.length ?? 1
  return {
    kind: "need_user",
    message: [
      `${lead}レビューで、仕様の曖昧な点（spec_gap）が見つかりました${remaining > 1 ? `（残り ${remaining} 件）` : ""}。実装の正否を判断するために、ユーザーに解釈を決めてもらってください。`,
      "",
      `- 対象の AC: ${gap.ac}`,
      `- 曖昧な点: ${gap.content}`,
      "",
      "解釈の選択肢:",
      ...gap.options.map((o, i) => `${i + 1}. ${o}`),
      "",
      "手順:",
      "1. 上の曖昧な点を短く説明する。判断に必要なら、issue やコードを読んでよい",
      "2. question ツールで、上の解釈を選択肢にして聞く（どれでもなければ、ユーザーに自由に書いてもらう）",
      `3. harness_record(run: "${run.id}", gate: "spec_gap", decision: "answered", feedback: 選ばれた解釈、または回答の文) を呼ぶ`,
      "issue へのコメントは投稿しない（下書きはハーネスが作る）",
    ].join("\n"),
  }
}

function appendDecision(worktree: string, number: number, gap: SpecGap, answer: string, at: string) {
  const path = decisionsPath(worktree)
  if (!existsSync(path)) writeFileSync(path, "# 仕様の確認の記録\n\nレビューで見つかった仕様の曖昧な点と、ユーザーが決めた解釈。以降のレビューと修正では、この解釈を仕様の正とする。\n")
  appendFileSync(
    path,
    [
      "",
      `## D-${number}（${gap.ac}、review ${gap.round} 周目の ${gap.id}）`,
      "",
      `- 曖昧な点: ${gap.content}`,
      `- 選択肢: ${gap.options.map((o, i) => `${i + 1}. ${o}`).join(" / ")}`,
      `- 決めた解釈: ${answer}`,
      `- 記録: ${at}`,
      "",
    ].join("\n"),
  )
}

function appendCommentDraft(worktree: string, issue: number, gap: SpecGap, answer: string) {
  const path = commentDraftPath(worktree)
  if (!existsSync(path)) writeFileSync(path, `<!-- issue #${issue} へのコメントの下書き（ハーネスは投稿しない） -->\n仕様の確認の結果を記録します。\n`)
  appendFileSync(path, ["", `### ${gap.ac} の解釈`, "", `- 確認した点: ${gap.content}`, `- 決めた解釈: ${answer}`, ""].join("\n"))
}
