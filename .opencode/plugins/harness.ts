// ハーネスのプラグインのエントリ。ツールとイベントを登録するだけにし、処理の本体は ../harness/ に置く（計画 5 章）
import { type Hooks, type Plugin, tool } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../harness/config.ts"
import { formatStatus } from "../harness/status.ts"
import { createStore, startRun } from "../harness/state.ts"
import { createEventBus, runChild, type PermissionRule } from "../harness/session.ts"
import { createSessionApi } from "../harness/sdk-adapter.ts"
import { advance, record, type RecordInput, type StepDeps } from "../harness/machine/dev.ts"
import { waive } from "../harness/steps/waiver.ts"
import { childSessionsUsed } from "../harness/steps/budget.ts"
import { startFix } from "../harness/steps/fix.ts"
import { FIX_AGENT, editedPaths, fixEditDenial, isAllowedFixCommand } from "../harness/fix-guard.ts"
import { realExec, realShell } from "../harness/exec.ts"
import { filterGrepOutput, guardHarnessTool } from "../harness/permissions.ts"

type Ctx = { worktree: string; directory: string }
type ToolCtx = Ctx & { sessionID: string; agent: string; abort: AbortSignal; metadata(input: { title?: string }): void }
const rootOf = (context: Ctx) => context.worktree || context.directory

export const HarnessPlugin: Plugin = async ({ client, directory, worktree }) => {
  const events = createEventBus()
  const api = createSessionApi(client)
  // セッションごとのエージェント（harness-fix の編集とコマンドを、フックで制限するため。#41）
  const sessionAgents = new Map<string, string>()
  const pluginRoot = worktree || directory
  const fixConfig = () => {
    const load = loadConfig(pluginRoot)
    return load.status === "ok" ? load.config : undefined
  }

  // 工程の実行に必要な依存を組み立てる。設定に問題があれば、その説明の文章を返す
  const stepDeps = (context: ToolCtx): StepDeps | string => {
    const root = rootOf(context)
    const load = loadConfig(root)
    if (load.status !== "ok") return formatStatus(load)
    const store = createStore(root)
    return {
      root,
      config: load.config,
      store,
      exec: realExec,
      shell: realShell,
      child: ({ runId, ...opts }) =>
        runChild(
          { api, events, log: (e) => store.appendEvent(runId, e), progress: (title) => context.metadata({ title }) },
          { ...opts, parentID: context.sessionID, signal: context.abort },
        ),
    }
  }

  const tools: NonNullable<Hooks["tool"]> = {
    harness_status: tool({
      description:
        "ハーネス（要件定義・TDD 開発・修正の自動化）の状態を表示する。run の一覧、状態、現在の工程、設定の誤りや警告を返す。ユーザーがハーネスの状態・進み具合を尋ねたときに使う。",
      args: {},
      async execute(_args, context) {
        const denied = guardHarnessTool(context.agent)
        if (denied) return denied
        const root = rootOf(context)
        const store = createStore(root)
        return formatStatus(loadConfig(root), store.list(), (id) => childSessionsUsed(store, id))
      },
    }),
    harness_start: tool({
      description:
        "ハーネスの run を開始する。kind が dev のときは、GitHub の issue 番号を arg に渡す。同じ issue の run がすでにあれば、新しく作らずに既存の run を返す。kind が fix のとき（/fix）は、エスカレーションした issue の run について、報告の要約と方針の選択肢を返す。",
      args: {
        kind: tool.schema.enum(["dev", "fix"]).describe("dev: issue の開発を始める・続ける。fix: エスカレーションした run を直す（/fix）"),
        arg: tool.schema.number().int().positive().describe("dev のときは issue 番号"),
      },
      async execute(args, context) {
        const denied = guardHarnessTool(context.agent)
        if (denied) return denied
        const root = rootOf(context)
        const load = loadConfig(root)
        if (load.status !== "ok") return formatStatus(load)
        if (args.kind === "fix") {
          const deps = stepDeps(context)
          if (typeof deps === "string") return deps
          const result = startFix(deps, args.arg)
          return `結果: ${result.kind}\n${result.message}`
        }
        const { run, created } = startRun(createStore(root), { kind: args.kind, issue: args.arg })
        return `${created ? "run を作成しました" : "既存の run を使います"}: ${run.id}（工程: ${run.step}）`
      },
    }),
    harness_advance: tool({
      description:
        "ハーネスの run を 1 工程だけ進める。戻り値の 1 行目が「結果: continue」ならもう一度呼ぶ。need_user ならユーザーと対話する。escalated / done / error なら止まって内容をユーザーに伝える。工程を自分で飛ばしたり、判断で進めたりしないこと。",
      args: {
        run: tool.schema.string().describe("run の ID（例: issue-12）"),
      },
      async execute(args, context) {
        const denied = guardHarnessTool(context.agent)
        if (denied) return denied
        const deps = stepDeps(context)
        if (typeof deps === "string") return deps
        const result = await advance(deps, args.run)
        return `結果: ${result.kind}\n${result.message}`
      },
    }),
    harness_record: tool({
      description:
        "ユーザーの判断を記録する。harness_advance が need_user で判断を求めたとき、question ツールで聞いた結果をそのまま渡す。計画の承認（gate: plan）は approved / changes_requested / aborted、依存先の確認（gate: dependency）は wait / stack / ignore、テストの変更申請（gate: test_change）は approved / rejected、仕様の曖昧な点（gate: spec_gap）は answered。修正指示や却下のときは、ユーザーの指示や理由を feedback に入れる。spec_gap では、ユーザーが選んだ解釈（または回答の文）を feedback に入れる。",
      args: {
        run: tool.schema.string().describe("run の ID（例: issue-12）"),
        gate: tool.schema.enum(["plan", "dependency", "test_change", "spec_gap"]).describe("どの判断か（plan: 計画の承認、dependency: 依存先の issue の確認、test_change: テストの変更申請、spec_gap: 仕様の曖昧な点への回答）"),
        decision: tool.schema
          .enum(["approved", "changes_requested", "aborted", "wait", "stack", "ignore", "rejected", "answered"])
          .describe("plan: 承認 / 修正指示 / 中断。dependency: 待つ / 依存先のブランチの上に積む / 無視して進める。test_change: 承認 / 却下。spec_gap: 回答した"),
        feedback: tool.schema.string().optional().describe("修正指示の内容・却下の理由・spec_gap への回答（changes_requested / rejected / answered のときは必須）"),
      },
      async execute(args, context) {
        const denied = guardHarnessTool(context.agent)
        if (denied) return denied
        const deps = stepDeps(context)
        if (typeof deps === "string") return deps
        const result = record(deps, args as RecordInput)
        return `結果: ${result.kind}\n${result.message}`
      },
    }),
    harness_waive: tool({
      description:
        "レビューの指摘を免除リストに追加する。ユーザーがはっきり免除を指示したときだけ使う（自分の判断で免除しない）。免除した指摘は、次のレビューから blocking に数えず、PR 本文に理由とともに載る。",
      args: {
        run: tool.schema.string().describe("run の ID（例: issue-12）"),
        finding: tool.schema.string().describe("指摘の ID（例: spec:AC-2:src/slug.ts）、または最新のレビューの番号（例: F-01）"),
        reason: tool.schema.string().describe("免除の理由（ユーザーから聞いたもの。必須）"),
      },
      async execute(args, context) {
        const denied = guardHarnessTool(context.agent)
        if (denied) return denied
        const deps = stepDeps(context)
        if (typeof deps === "string") return deps
        const result = waive(deps, args)
        return `結果: ${result.kind}\n${result.message}`
      },
    }),
  }

  // 開発用: 子セッションの実行器を単体で試す。HARNESS_DEBUG=1 のときだけ登録する
  if (process.env.HARNESS_DEBUG === "1")
    tools.harness_debug_child = tool({
      description: "【開発用】指定したエージェントとモデルで子セッションを 1 回実行し、結果を JSON で返す。",
      args: {
        agent: tool.schema.string(),
        model: tool.schema.string().describe("provider/model"),
        prompt: tool.schema.string(),
        directory: tool.schema.string().optional().describe("子セッションの作業ディレクトリ。省略時は現在のディレクトリ"),
        permission: tool.schema.string().optional().describe("PermissionRule の配列（JSON）"),
      },
      async execute(args, context) {
        const root = rootOf(context)
        const logFile = join(root, ".harness", "debug-events.jsonl")
        mkdirSync(join(root, ".harness"), { recursive: true })
        const result = await runChild(
          {
            api,
            events,
            log: (e) => appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...e }) + "\n"),
            progress: (title) => context.metadata({ title }),
          },
          {
            parentID: context.sessionID,
            directory: args.directory ?? context.directory,
            title: `debug: ${args.agent}`,
            agent: args.agent,
            model: args.model,
            prompt: args.prompt,
            permission: args.permission ? (JSON.parse(args.permission) as PermissionRule[]) : undefined,
            signal: context.abort,
          },
        )
        return JSON.stringify(result, null, 2)
      },
    })

  return {
    tool: tools,
    "chat.message": async (input) => {
      if (input.agent) sessionAgents.set(input.sessionID, input.agent)
    },
    // harness-fix は、テストファイル・ハーネスの成果物・秘密情報を編集できない（エージェント定義に静的に書けないため、ここで拒否する）
    "tool.execute.before": async (input, output) => {
      if (sessionAgents.get(input.sessionID) !== FIX_AGENT || editedPaths(input.tool, output.args).length === 0) return
      const config = fixConfig()
      if (!config) throw new Error("harness.config.json を読み込めないため、harness-fix の編集を止めました")
      const denied = fixEditDenial(config, input.tool, output.args)
      if (denied) throw new Error(denied)
    },
    // harness-fix が checks のコマンドを実行するときは、確認なしで許可する（それ以外のコマンドは確認する）
    "permission.ask": async (input, output) => {
      if (sessionAgents.get(input.sessionID) !== FIX_AGENT || input.type !== "bash") return
      const config = fixConfig()
      const command = typeof input.metadata?.command === "string" ? input.metadata.command : Array.isArray(input.pattern) ? input.pattern.join(" ") : (input.pattern ?? "")
      if (config && isAllowedFixCommand(config, command)) output.status = "allow"
    },
    // grep の結果から .env などの秘密情報の行を取り除く（read の拒否だけでは grep で読めてしまうため）
    "tool.execute.after": async (input, output) => {
      if (input.tool === "grep" && typeof output.output === "string") output.output = filterGrepOutput(output.output)
    },
    event: async ({ event }) => {
      events.emit(event as { type: string; properties?: Record<string, unknown> })
    },
  }
}
