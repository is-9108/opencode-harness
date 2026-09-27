// ハーネスのプラグインのエントリ。ツールを登録するだけにし、処理の本体は ../harness/ に置く（計画 5 章）
import { type Plugin, tool } from "@opencode-ai/plugin"
import { loadConfig } from "../harness/config.ts"
import { formatStatus } from "../harness/status.ts"

export const HarnessPlugin: Plugin = async () => ({
  tool: {
    harness_status: tool({
      description:
        "ハーネス（要件定義・TDD 開発・修正の自動化）の状態を表示する。run の一覧、現在の工程、設定の誤りや警告を返す。ユーザーがハーネスの状態・進み具合を尋ねたときに使う。",
      args: {},
      async execute(_args, context) {
        return formatStatus(loadConfig(context.worktree || context.directory))
      },
    }),
  },
})
