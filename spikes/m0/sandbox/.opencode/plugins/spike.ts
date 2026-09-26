import { tool } from "@opencode-ai/plugin"
import { appendFileSync } from "node:fs"
import { join } from "node:path"

export const SpikePlugin = async ({ client, directory }: any) => {
  const log = (o: any) => appendFileSync(join(directory, "spike-events.jsonl"), JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n")
  log({ kind: "plugin-loaded", directory })
  const continued = new Set<string>()
  return {
    tool: {
      spike_sleep: tool({
        description: "Sleep for N seconds (spike). Logs start/end/abort.",
        args: { seconds: tool.schema.number() },
        async execute(args: any, context: any) {
          log({ kind: "tool-start", seconds: args.seconds, ctxKeys: Object.keys(context ?? {}), sessionID: context?.sessionID, directory: context?.directory, worktree: context?.worktree })
          const start = Date.now()
          const sig: AbortSignal | undefined = context?.abort
          sig?.addEventListener?.("abort", () => log({ kind: "tool-abort-signal", after: Date.now() - start }))
          while (Date.now() - start < args.seconds * 1000) {
            if (sig?.aborted) { log({ kind: "tool-aborted", after: Date.now() - start }); return "ABORTED" }
            await new Promise((r) => setTimeout(r, 1000))
          }
          log({ kind: "tool-end", after: Date.now() - start })
          return `slept ${args.seconds}s`
        },
      }),
    },
    event: async ({ event }: any) => {
      const t = event?.type ?? ""
      if (t.startsWith("message.part")) return
      if (["session.status", "session.idle", "session.error", "session.compacted", "permission.asked", "permission.updated", "session.created"].includes(t) || t.startsWith("permission")) {
        log({ kind: "event", type: t, props: event.properties })
      }
      if (t === "session.idle") {
        const id = event.properties?.sessionID
        if (!id || continued.has(id)) return
        try {
          const s = await client.session.get({ path: { id } })
          const title = s?.data?.title ?? ""
          if (title.includes("[autocontinue]")) {
            continued.add(id)
            log({ kind: "autocontinue-send", id })
            await client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text: "Reply with exactly: AUTO-CONTINUED" }] } })
          }
        } catch (e: any) { log({ kind: "autocontinue-error", msg: String(e?.message ?? e) }) }
      }
    },
  }
}
