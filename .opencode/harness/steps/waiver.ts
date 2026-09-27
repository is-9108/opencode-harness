// 免除リスト（計画 8.4、#39）。ユーザーが免除した指摘は、レビューで blocking に数えず、PR 本文の「免除した指摘」に載せる。
// 免除できるのは司令塔（harness_waive）だけ。子エージェントによる免除は常にできない（waivers.md は成果物として編集を拒否している）
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StepDeps, StepResult } from "../machine/dev.ts"
import type { RunState } from "../state.ts"
import { runDir } from "./common.ts"

export type Waiver = { key: string; finding: string; reason: string; at: string }
export type WaiveInput = { run: string; finding: string; reason?: string }

export const waiversPath = (worktree: string) => join(runDir(worktree), "waivers.md")

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim()
const uncell = (s: string) => s.replace(/\\\|/g, "|").trim()

export function readWaivers(worktree: string): Waiver[] {
  const path = waiversPath(worktree)
  if (!worktree || !existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.split(/(?<!\\)\|/).map(uncell))
    .filter((cells) => cells.length >= 6 && cells[1] && cells[1] !== "ID" && !/^-+$/.test(cells[1]))
    .map((cells) => ({ key: cells[1]!, finding: cells[2]!, reason: cells[3]!, at: cells[4]! }))
}

export function waive(deps: StepDeps, input: WaiveInput): StepResult {
  const run = deps.store.get(input.run)
  if (!run) return { kind: "error", message: `run ${input.run} がありません` }
  const worktree = run.worktree
  if (!worktree) return { kind: "error", message: `${run.id} にはまだ worktree がありません（レビューの前は免除できる指摘がありません）` }
  const reason = input.reason?.trim()
  if (!reason) return { kind: "error", message: "免除の理由（reason）が空です。ユーザーに理由を聞いてください" }

  const resolved = resolveFinding(run, worktree, input.finding.trim())
  if (!resolved) {
    const known = Object.keys(run.findingRounds ?? {})
    return {
      kind: "error",
      message: [`指摘「${input.finding}」は、この run のレビューで blocking として出ていません。免除できるのは、blocking として出た指摘の ID だけです。`, ...(known.length ? ["これまでに出た ID:", ...known.map((k) => `- ${k}`)] : ["（まだ blocking の指摘は出ていません）"])].join("\n"),
    }
  }
  if (readWaivers(worktree).some((w) => w.key === resolved.key)) return { kind: "error", message: `指摘 ${resolved.key} は、すでに免除されています（${waiversPath(worktree)}）` }

  const path = waiversPath(worktree)
  if (!existsSync(path))
    writeFileSync(path, "# 免除リスト\n\nユーザーが免除した指摘。レビューでは blocking に数えず、PR 本文の「免除した指摘」に載せる。\n\n| ID | 指摘 | 理由 | 日時 |\n|---|---|---|---|\n")
  const at = (deps.now?.() ?? new Date()).toISOString()
  appendFileSync(path, `| ${cell(resolved.key)} | ${cell(resolved.content || "-")} | ${cell(reason)} | ${at} |\n`)
  deps.store.appendEvent(run.id, { type: "finding.waived", key: resolved.key, reason })
  return { kind: "done", message: `指摘 ${resolved.key} を免除しました（${path}）。次のレビューから blocking に数えず、PR 本文の「免除した指摘」に理由とともに載せます` }
}

// 指摘の ID（spec:AC-2:src/slug.ts）か、最新の周の番号（F-01）から、blocking として出たことのある指摘を探す
function resolveFinding(run: RunState, worktree: string, finding: string): { key: string; content: string } | undefined {
  const known = run.findingRounds ?? {}
  const latest = blockingLines(worktree, run.reviewRounds ?? 0)
  if (/^F-\d+$/.test(finding)) {
    const line = latest.find((l) => l.id === finding)
    return line && known[line.key] ? line : undefined
  }
  if (!known[finding]) return undefined
  // 指摘の内容は、その ID が最後に出た周の集計から取る
  const round = Math.max(...known[finding]!)
  return { key: finding, content: blockingLines(worktree, round).find((l) => l.key === finding)?.content ?? "" }
}

// 集計（summary.md）の「blocking」の欄の行: 「- F-01（spec_violation、AC-2、src/slug.ts:1、ID: spec:AC-2:src/slug.ts）: 内容」
function blockingLines(worktree: string, round: number): { id: string; key: string; content: string }[] {
  const path = join(runDir(worktree), "reviews", `round-${round}`, "summary.md")
  if (round < 1 || !existsSync(path)) return []
  const section = readFileSync(path, "utf8").match(/^## blocking[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? ""
  return [...section.matchAll(/^- (F-\d+)（.*?ID: ([^）]+)）: (.*)$/gm)].map((m) => ({ id: m[1]!, key: m[2]!, content: `${m[1]}: ${m[3]}` }))
}
