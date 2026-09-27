// 失敗の指紋（計画 8.3）。同じ失敗が続いているか（進んでいないか）を判定するために使う。
// 行番号・一時パス・色の制御文字など、実行ごとに変わる部分を取り除いてから、並べ替えてハッシュにする
import { createHash } from "node:crypto"

const ANSI = /\x1b\[[0-9;]*m/g
// Windows（C:\...）と POSIX（/...）の絶対パス、相対パス（a/b.ts）をまとめて <path> にする
const PATH = /(?:[A-Za-z]:)?(?:[\\/][^\s'"`()[\]{}<>,;]+)+|[\w.-]+(?:[\\/][\w.-]+)+/g

export function normalizeMessage(message: string): string {
  return message.replace(ANSI, "").replace(PATH, "<path>").replace(/\d+/g, "#").replace(/\s+/g, " ").trim()
}

// 失敗の項目（テストの ID とメッセージ、エラーの行など）から指紋を作る。項目の順番には依存しない
export function fingerprint(items: string[]): string {
  const sorted = [...new Set(items)].sort()
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16)
}
