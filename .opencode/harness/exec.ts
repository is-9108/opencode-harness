// 外部コマンド（git、gh）の実行。シェルを経由せず引数を配列で渡す（計画 13 章: Windows のパスや引用符の問題を避ける）
import { execFile } from "node:child_process"

export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[], opts: { cwd: string }) => Promise<ExecResult>

const MAX_BUFFER = 32 * 1024 * 1024

export const realExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && typeof error.code !== "number" ? error.message : "")) })
    })
  })
