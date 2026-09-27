// ハーネスのプラグインのエントリ。ツールとイベントを登録するだけにし、処理の本体は ../harness/ に置く（計画 5 章）
import { type Hooks, type Plugin, tool } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../harness/config.ts"
import { formatStatus } from "../harness/status.ts"
import { createStore, startRun } from "../harness/state.ts"
import { createEventBus, runChild, type PermissionRule } from "../harness/session.ts"
import { createSessionApi } from "../harness/sdk-adapter.ts"
import { advance, record, type StepDeps } from "../harness/machine/dev.ts"
import { realExec, realShell } from "../harness/exec.ts"
import { guardHarnessTool } from "../harness/permissions.ts"

type Ctx = { worktree: string; directory: string }
type ToolCtx = Ctx & { sessionID: string; agent: string; abort: AbortSignal; metadata(input: { title?: string }): void }
const rootOf = (context: Ctx) => context.worktree || context.directory

export const HarnessPlugin: Plugin = async ({ client }) => {
  const events = createEventBus()
  const api = createSessionApi(client)

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
        const denied = guardHarnessTool(context.agent)
        if (denied) return denied
        const root = rootOf(context)
        const load = loadConfig(root)
        if (load.status !== "ok") return formatStatus(load)
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
        "ユーザーの判断を記録する。harness_advance が need_user で承認を求めたとき、question ツールで聞いた結果をそのまま渡す。修正指示のときは、ユーザーの指示の内容を feedback に入れる。",
      args: {
        run: tool.schema.string().describe("run の ID（例: issue-12）"),
        gate: tool.schema.enum(["plan"]).describe("どの承認か"),
        decision: tool.schema.enum(["approved", "changes_requested", "aborted"]).describe("承認 / 修正指示 / 中断"),
        feedback: tool.schema.string().optional().describe("修正指示の内容（changes_requested のときは必須）"),
      },
      async execute(args, context) {
        const denied = guardHarnessTool(context.agent)
        if (denied) return denied
        const deps = stepDeps(context)
        if (typeof deps === "string") return deps
        const result = record(deps, args)
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
    event: async ({ event }) => {
      events.emit(event as { type: string; properties?: Record<string, unknown> })
    },
  }
}
