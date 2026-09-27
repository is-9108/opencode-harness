import { test } from "node:test"
import assert from "node:assert/strict"
import { createEventBus, parseModel, runChild, type ChildEvent } from "../session.ts"
import { createFakeApi, defaultResult } from "./fakes.ts"

const base = {
  parentID: "ses_parent",
  directory: "C:/work/repo.worktrees/issue-12",
  title: "issue-12: plan",
  agent: "dev-planner",
  model: "openai/gpt-6-luna",
  prompt: "計画を作って",
}

const setup = (opts: Parameters<typeof createFakeApi>[1] = {}) => {
  const events = createEventBus()
  const { api, calls } = createFakeApi(events, opts)
  const logged: ChildEvent[] = []
  return { deps: { api, events, log: (e: ChildEvent) => logged.push(e) }, calls, logged, events }
}

test("子セッションを作って依頼を送り、idle を受けたらテキストとトークンを返して記録する", async () => {
  const { deps, calls, logged } = setup()
  const permission = [{ permission: "external_directory", pattern: "*repo.worktrees*", action: "allow" as const }]
  const result = await runChild(deps, { ...base, permission })

  assert.equal(result.status, "completed")
  assert.equal(result.status === "completed" && result.text, "done")
  assert.deepEqual(result.status === "completed" && result.tokens, defaultResult().tokens)
  assert.deepEqual(calls[0], { op: "create", parentID: "ses_parent", title: base.title, directory: base.directory, permission })
  assert.deepEqual(calls[1], {
    op: "promptAsync", sessionID: result.sessionID, directory: base.directory,
    agent: "dev-planner", model: { providerID: "openai", modelID: "gpt-6-luna" }, text: base.prompt,
  })
  const done = logged.find((e) => e.type === "child.completed")
  assert.ok(done)
  assert.equal(done.sessionID, result.sessionID)
  assert.deepEqual(done.tokens, defaultResult().tokens)
})

test("実行中に親のツールが中断されたら、子セッションにも abort を送り、中断として返す", async () => {
  const controller = new AbortController()
  const { deps, calls } = setup({ onPrompt: () => setTimeout(() => controller.abort(), 0) })
  const result = await runChild(deps, { ...base, signal: controller.signal })
  assert.equal(result.status, "aborted")
  assert.deepEqual(calls.at(-1), { op: "abort", sessionID: result.sessionID })
})

test("完了した後に発火した abort は無視する（M0-2: 完了直後にも abort が発火する）", async () => {
  const controller = new AbortController()
  const { deps, calls } = setup({ onPrompt: (_id, idle) => setTimeout(() => { idle(); controller.abort() }, 0) })
  const result = await runChild(deps, { ...base, signal: controller.signal })
  assert.equal(result.status, "completed")
  assert.equal(calls.some((c) => c.op === "abort"), false)
})

test("すでに中断されたシグナルで呼ばれたら、子セッションを作らずに中断として返す", async () => {
  const controller = new AbortController()
  controller.abort()
  const { deps, calls } = setup()
  const result = await runChild(deps, { ...base, signal: controller.signal })
  assert.equal(result.status, "aborted")
  assert.equal(calls.length, 0)
})

test("子セッションがエラーで終わったら、エラーの内容を返す。再試行や切り替えはしない", async () => {
  const { deps, calls, logged } = setup({ result: { ...defaultResult(), text: "", error: { name: "APIError", message: "Bad Request" } } })
  const result = await runChild(deps, base)
  assert.equal(result.status, "error")
  assert.match(result.status === "error" ? result.error : "", /APIError.*Bad Request/)
  assert.equal(calls.filter((c) => c.op === "promptAsync").length, 1)
  assert.ok(logged.some((e) => e.type === "child.error"))
})

test("依頼の送信そのものが失敗したら、エラーとして返す", async () => {
  const { deps } = setup({ promptError: new Error("connection refused") })
  const result = await runChild(deps, base)
  assert.equal(result.status, "error")
  assert.match(result.status === "error" ? result.error : "", /connection refused/)
})

test("既存の子セッションを指定したら、新しく作らずにそのセッションへ続きを送る", async () => {
  const { deps, calls } = setup()
  const result = await runChild(deps, { ...base, sessionID: "ses_existing", prompt: "続きから" })
  assert.equal(result.sessionID, "ses_existing")
  assert.equal(calls.some((c) => c.op === "create"), false)
  assert.equal(calls[0]?.op === "promptAsync" && calls[0].sessionID, "ses_existing")
})

test("idle が依頼の送信中に同期的に届いても取りこぼさない", async () => {
  const { deps } = setup({ onPrompt: (_id, idle) => idle() })
  const result = await runChild(deps, base)
  assert.equal(result.status, "completed")
})

test("ほかのセッションの idle では完了しない", async () => {
  const { deps, events } = setup({
    onPrompt: (id, idle) => {
      events.emit({ type: "session.idle", properties: { sessionID: "ses_other" } })
      setTimeout(idle, 5)
    },
  })
  let settled = false
  const pending = runChild(deps, base).then((r) => ((settled = true), r))
  await new Promise((r) => setTimeout(r, 1))
  assert.equal(settled, false)
  assert.equal((await pending).status, "completed")
})

test("モデルの指定は provider/model の形式を分解する。形式が違えば子セッションを作る前にエラーにする", async () => {
  assert.deepEqual(parseModel("openai/gpt-6-luna"), { providerID: "openai", modelID: "gpt-6-luna" })
  assert.deepEqual(parseModel("mock/org/model"), { providerID: "mock", modelID: "org/model" })
  const { deps, calls } = setup()
  await assert.rejects(runChild(deps, { ...base, model: "gpt-5.5" }), /provider\/model/)
  assert.equal(calls.length, 0)
})
