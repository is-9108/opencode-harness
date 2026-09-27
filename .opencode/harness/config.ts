// harness.config.json の読み込み、既定値の補完、検証（計画 6 章）
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const CONFIG_FILE = "harness.config.json"
export const EXAMPLE_FILE = "harness.config.example.json"

export type Perspective = {
  name: string
  session: "separate" | "advisory"
  blocking: boolean
  rounds: "every" | "first"
  model?: string
}

export type Check = { name: string; command: string; junit?: string; timeoutSec: number }

export type HarnessConfig = {
  providers: {
    fallbackChain: string[]
    limitRetryReasons: string[]
    limitRetryWaitSec: number
    authErrorPatterns: string[]
    cooldownMinutes: number
    probeModels: boolean
  }
  models: Record<string, string[]>
  steps: Record<string, { maxSteps?: number; timeoutMin?: number }>
  checks: Check[]
  tests: { globs: string[]; flakyRetries: number }
  dependencyManifests: string[]
  loops: { testFix: number; reviewFix: number; autoFixBudget: number; reviewRoundsInHumanMode: number; sameFingerprintLimit: number }
  budget: { maxChildSessionsPerIssue: number; maxTokensPerIssue: number; maxCostUsdPerIssue: number; warnAtRatio: number }
  context: { compactAtTokens: number; reserved: number; prune: boolean }
  git: { branch: string; baseBranch: string; worktreeRoot: string }
  // worktree を作った直後に実行する依存のインストール（node_modules などは worktree にコピーされないため）
  setup: { install?: string; timeoutSec: number }
  review: { perspectives: Perspective[]; advisoryModel: string }
}

export type LoadResult =
  | { status: "ok"; path: string; config: HarnessConfig; warnings: string[] }
  | { status: "missing"; path: string; examplePath: string }
  | { status: "invalid"; path: string; errors: string[] }

const DEFAULT_CHECK_TIMEOUT_SEC = 600

const DEFAULTS = {
  providers: {
    fallbackChain: ["opencode-go", "openai"],
    limitRetryReasons: ["account_rate_limit", "free_tier_limit"],
    limitRetryWaitSec: 120,
    authErrorPatterns: ["401", "unauthorized", "invalid_grant", "token expired"],
    cooldownMinutes: 60,
    probeModels: true,
  },
  steps: { default: { maxSteps: 60, timeoutMin: 30 } },
  tests: { flakyRetries: 1 },
  dependencyManifests: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
  loops: { testFix: 3, reviewFix: 3, autoFixBudget: 6, reviewRoundsInHumanMode: 1, sameFingerprintLimit: 2 },
  budget: { maxChildSessionsPerIssue: 40, maxTokensPerIssue: 5_000_000, maxCostUsdPerIssue: 20, warnAtRatio: 0.8 },
  context: { compactAtTokens: 240_000, reserved: 20_000, prune: true },
  git: { branch: "feat/{issue}-{slug}", baseBranch: "main", worktreeRoot: "../{repo}.worktrees" },
  setup: { install: undefined as string | undefined, timeoutSec: 900 },
  review: {
    perspectives: [
      { name: "spec", session: "separate", blocking: true, rounds: "every", model: "dev.review.spec" },
      { name: "test-integrity", session: "separate", blocking: true, rounds: "every", model: "dev.review.integrity" },
      { name: "quality", session: "advisory", blocking: false, rounds: "first" },
      { name: "security", session: "advisory", blocking: false, rounds: "first" },
      { name: "performance", session: "advisory", blocking: false, rounds: "first" },
    ] as Perspective[],
    advisoryModel: "dev.review.advisory",
  },
}

const TOP_LEVEL_KEYS = ["$schema", "providers", "models", "steps", "checks", "tests", "dependencyManifests", "loops", "budget", "context", "git", "setup", "review"]
const MODEL_REF = /^[^/\s]+\/\S+$/

export function loadConfig(rootDir: string): LoadResult {
  const path = join(rootDir, CONFIG_FILE)
  if (!existsSync(path)) return { status: "missing", path, examplePath: join(rootDir, EXAMPLE_FILE) }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    return { status: "invalid", path, errors: [`JSON として読み込めません: ${(e as Error).message}`] }
  }
  const { config, errors, warnings } = validateConfig(raw)
  return config ? { status: "ok", path, config, warnings } : { status: "invalid", path, errors }
}

export function validateConfig(raw: unknown): { config?: HarnessConfig; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const err = (path: string, message: string) => errors.push(`${path}: ${message}`)

  if (!isObject(raw)) return { errors: ["設定はオブジェクトである必要があります"], warnings }
  for (const key of Object.keys(raw)) if (!TOP_LEVEL_KEYS.includes(key)) err(key, "未知のキーです")

  // 既定値を持つセクション: 指定されたキーだけを上書きする。未知のキーはエラー
  const section = <T extends Record<string, unknown>>(name: string, defaults: T): T => {
    const value = raw[name]
    if (value === undefined) return { ...defaults }
    if (!isObject(value)) {
      err(name, "オブジェクトである必要があります")
      return { ...defaults }
    }
    for (const key of Object.keys(value)) if (!(key in defaults)) err(`${name}.${key}`, "未知のキーです")
    return { ...defaults, ...value } as T
  }

  const providers = section("providers", DEFAULTS.providers)
  stringArray(providers.fallbackChain, "providers.fallbackChain", err, { nonEmpty: true })
  stringArray(providers.limitRetryReasons, "providers.limitRetryReasons", err)
  stringArray(providers.authErrorPatterns, "providers.authErrorPatterns", err)
  positiveInt(providers.limitRetryWaitSec, "providers.limitRetryWaitSec", err)
  positiveInt(providers.cooldownMinutes, "providers.cooldownMinutes", err)
  bool(providers.probeModels, "providers.probeModels", err)

  const loops = section("loops", DEFAULTS.loops)
  for (const [key, value] of Object.entries(loops)) positiveInt(value, `loops.${key}`, err)

  const budget = section("budget", DEFAULTS.budget)
  positiveInt(budget.maxChildSessionsPerIssue, "budget.maxChildSessionsPerIssue", err)
  positiveInt(budget.maxTokensPerIssue, "budget.maxTokensPerIssue", err)
  if (typeof budget.maxCostUsdPerIssue !== "number" || budget.maxCostUsdPerIssue <= 0) err("budget.maxCostUsdPerIssue", "正の数である必要があります")
  if (typeof budget.warnAtRatio !== "number" || budget.warnAtRatio <= 0 || budget.warnAtRatio >= 1) err("budget.warnAtRatio", "0 より大きく 1 より小さい数である必要があります")

  const context = section("context", DEFAULTS.context)
  positiveInt(context.compactAtTokens, "context.compactAtTokens", err)
  positiveInt(context.reserved, "context.reserved", err)
  bool(context.prune, "context.prune", err)

  const git = section("git", DEFAULTS.git)
  for (const [key, value] of Object.entries(git)) if (typeof value !== "string" || value === "") err(`git.${key}`, "空でない文字列である必要があります")

  const setup = section("setup", DEFAULTS.setup)
  if (setup.install !== undefined && (typeof setup.install !== "string" || setup.install.trim() === "")) err("setup.install", "空でない文字列である必要があります（不要なら省略してください）")
  positiveInt(setup.timeoutSec, "setup.timeoutSec", err)

  const tests = section("tests", { globs: [] as string[], ...DEFAULTS.tests })
  stringArray(tests.globs, "tests.globs", err, { nonEmpty: true })
  if (!Number.isInteger(tests.flakyRetries) || tests.flakyRetries < 0) err("tests.flakyRetries", "0 以上の整数である必要があります")

  const models: Record<string, string[]> = {}
  if (!isObject(raw.models)) err("models", "オブジェクトである必要があります")
  else
    for (const [step, chain] of Object.entries(raw.models)) {
      if (!Array.isArray(chain) || chain.length === 0 || !chain.every((m) => typeof m === "string" && MODEL_REF.test(m)))
        err(`models.${step}`, "provider/model 形式の文字列を 1 件以上並べた配列である必要があります")
      else models[step] = chain
    }

  const steps: HarnessConfig["steps"] = { ...DEFAULTS.steps }
  if (raw.steps !== undefined) {
    if (!isObject(raw.steps)) err("steps", "オブジェクトである必要があります")
    else
      for (const [step, limits] of Object.entries(raw.steps)) {
        if (!isObject(limits)) { err(`steps.${step}`, "オブジェクトである必要があります"); continue }
        for (const key of Object.keys(limits)) if (key !== "maxSteps" && key !== "timeoutMin") err(`steps.${step}.${key}`, "未知のキーです")
        if (limits.maxSteps !== undefined) positiveInt(limits.maxSteps, `steps.${step}.maxSteps`, err)
        if (limits.timeoutMin !== undefined) positiveInt(limits.timeoutMin, `steps.${step}.timeoutMin`, err)
        steps[step] = limits as HarnessConfig["steps"][string]
      }
  }

  const checks: Check[] = []
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) err("checks", "1 件以上のチェックを並べた配列である必要があります")
  else
    raw.checks.forEach((c, i) => {
      const at = `checks[${i}]`
      if (!isObject(c)) return err(at, "オブジェクトである必要があります")
      for (const key of Object.keys(c)) if (!["name", "command", "junit", "timeoutSec"].includes(key)) err(`${at}.${key}`, "未知のキーです")
      if (typeof c.name !== "string" || c.name === "") err(`${at}.name`, "空でない文字列である必要があります")
      if (typeof c.command !== "string" || c.command === "") err(`${at}.command`, "空でない文字列である必要があります")
      if (c.junit !== undefined && typeof c.junit !== "string") err(`${at}.junit`, "文字列である必要があります")
      if (c.timeoutSec !== undefined) positiveInt(c.timeoutSec, `${at}.timeoutSec`, err)
      if (checks.some((prev) => prev.name === c.name)) err(`${at}.name`, `チェックの名前「${String(c.name)}」が重複しています`)
      checks.push({ name: c.name as string, command: c.command as string, junit: c.junit as string | undefined, timeoutSec: (c.timeoutSec as number | undefined) ?? DEFAULT_CHECK_TIMEOUT_SEC })
    })

  const dependencyManifests = raw.dependencyManifests === undefined ? [...DEFAULTS.dependencyManifests] : (raw.dependencyManifests as string[])
  stringArray(dependencyManifests, "dependencyManifests", err)

  const review = section("review", DEFAULTS.review)
  if (!Array.isArray(review.perspectives) || review.perspectives.length === 0) err("review.perspectives", "1 件以上の観点を並べた配列である必要があります")
  else
    review.perspectives.forEach((p: unknown, i) => {
      const at = `review.perspectives[${i}]`
      if (!isObject(p)) return err(at, "オブジェクトである必要があります")
      const label = typeof p.name === "string" ? `${at}（${p.name}）` : at
      for (const key of Object.keys(p)) if (!["name", "session", "blocking", "rounds", "model"].includes(key)) err(`${label}.${key}`, "未知のキーです")
      if (typeof p.name !== "string" || p.name === "") err(`${at}.name`, "空でない文字列である必要があります")
      if (p.session !== "separate" && p.session !== "advisory") err(`${label}.session`, "\"separate\" か \"advisory\" である必要があります")
      if (typeof p.blocking !== "boolean") err(`${label}.blocking`, "真偽値である必要があります")
      if (p.rounds !== "every" && p.rounds !== "first") err(`${label}.rounds`, "\"every\" か \"first\" である必要があります")
      if (p.session === "advisory" && p.blocking === true)
        err(label, "advisory の観点は blocking にできません。ループの判定に使う観点は session: \"separate\" にしてください")
      if (p.session === "separate") {
        if (typeof p.model !== "string") err(`${label}.model`, "separate の観点には、models のキーを指定する必要があります")
        else if (!(p.model in models)) warnings.push(`${label}: models に「${p.model}」がありません`)
      }
    })
  if (typeof review.advisoryModel !== "string") err("review.advisoryModel", "文字列である必要があります")
  else if (Array.isArray(review.perspectives) && review.perspectives.some((p) => p?.session === "advisory") && !(review.advisoryModel in models))
    warnings.push(`review.advisoryModel: models に「${review.advisoryModel}」がありません`)

  if (errors.length > 0) return { errors, warnings }
  return {
    config: { providers, models, steps, checks, tests, dependencyManifests, loops, budget, context, git, setup, review },
    errors,
    warnings,
  }
}

type Err = (path: string, message: string) => void

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function positiveInt(v: unknown, path: string, err: Err) {
  if (!Number.isInteger(v) || (v as number) <= 0) err(path, "1 以上の整数である必要があります")
}

function bool(v: unknown, path: string, err: Err) {
  if (typeof v !== "boolean") err(path, "真偽値である必要があります")
}

function stringArray(v: unknown, path: string, err: Err, opts: { nonEmpty?: boolean } = {}) {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s !== "")) err(path, "空でない文字列の配列である必要があります")
  else if (opts.nonEmpty && v.length === 0) err(path, "1 件以上必要です")
}
