// 外部コマンド（git、gh）の実行。シェルを経由せず引数を配列で渡す（計画 13 章: Windows のパスや引用符の問題を避ける）
import { execFile, spawn } from "node:child_process"

export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[], opts: { cwd: string }) => Promise<ExecResult>

export type ShellResult = { code: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }
// 設定の checks に書かれたコマンド（npm test など）の実行。こちらはシェルを経由する（npx などを Windows でも解決するため）
export type Shell = (command: string, opts: { cwd: string; timeoutSec: number }) => Promise<ShellResult>

const MAX_BUFFER = 32 * 1024 * 1024
const OUTPUT_LIMIT = 200_000

export const realShell: Shell = (command, opts) =>
  new Promise((resolve) => {
    const started = Date.now()
    // Windows 以外ではプロセスグループを作り、タイムアウト時に子孫ごと止められるようにする
    const child = spawn(command, { cwd: opts.cwd, shell: true, windowsHide: true, detached: process.platform !== "win32" })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    // 出力は末尾だけを残す（テストの出力が巨大になっても、メモリと成果物を圧迫しないため）
    const keepTail = (s: string) => (s.length > OUTPUT_LIMIT ? s.slice(-OUTPUT_LIMIT) : s)
    child.stdout.on("data", (d) => (stdout = keepTail(stdout + d)))
    child.stderr.on("data", (d) => (stderr = keepTail(stderr + d)))
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, opts.timeoutSec * 1000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr, timedOut, durationMs: Date.now() - started })
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: stderr + e.message, timedOut, durationMs: Date.now() - started })
    })
  })

// シェル経由で起動したプロセスは子孫ごと止める（Windows では taskkill /T が必要）
function killTree(pid: number | undefined) {
  if (pid === undefined) return
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true })
  else {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      process.kill(pid, "SIGKILL")
    }
  }
}

export const realExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && typeof error.code !== "number" ? error.message : "")) })
    })
  })
