// ハーネスのプラグインのエントリ。ツールを登録するだけにし、処理の本体は ../harness/ に置く（計画 5 章）
import { type Plugin, tool } from "@opencode-ai/plugin"
import { loadConfig } from "../harness/config.ts"
import { formatStatus } from "../harness/status.ts"
import { createStore, startRun } from "../harness/state.ts"

type Ctx = { worktree: string; directory: string }
const rootOf = (context: Ctx) => context.worktree || context.directory

export const HarnessPlugin: Plugin = async () => ({
  tool: {
    harness_status: tool({
      description:
        "ハーネス（要件定義・TDD 開発・修正の自動化）の状態を表示する。run の一覧、状態、現在の工程、設定の誤りや警告を返す。ユーザーがハーネスの状態・進み具合を尋ねたときに使う。",
      args: {},
      async execute(_args, context) {
        const root = rootOf(context)
        return formatStatus(loadConfig(root), createStore(root).list())
      },
    }),
    harness_start: tool({
      description:
        "ハーネスの run を開始する。kind が dev のときは、GitHub の issue 番号を arg に渡す。同じ issue の run がすでにあれば、新しく作らずに既存の run を返す。",
      args: {
        kind: tool.schema.enum(["dev"]).describe("run の種類。現在は dev（issue の開発）のみ"),
        arg: tool.schema.number().int().positive().describe("dev のときは issue 番号"),
      },
      async execute(args, context) {
        const root = rootOf(context)
        const load = loadConfig(root)
        if (load.status !== "ok") return formatStatus(load)
        const { run, created } = startRun(createStore(root), { kind: args.kind, issue: args.arg })
        return `${created ? "run を作成しました" : "既存の run を使います"}: ${run.id}（工程: ${run.step}）`
      },
    }),
  },
})
