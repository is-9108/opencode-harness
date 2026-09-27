// エージェントをまたいで共通の権限と、ハーネスのツールを使えるエージェントの制限（計画 9 章）
import type { PermissionRule } from "./session.ts"

// ハーネスのツール（harness_*）を使えるエージェント。司令塔だけに限る（M2 で harness-fix を加える）。
// harness_status も制限する（ループの残り回数や予算を、作業用のエージェントに知らせないため）
export const HARNESS_AGENTS = ["harness"]

// ハーネスのツールを呼んだエージェントを確かめる。使えないエージェントなら、その理由の文章を返す。
// ツールは全エージェントに見えるため（docs/omo-evaluation.md）、設定ではなくコードで拒否する
export function guardHarnessTool(agent: string): string | undefined {
  if (HARNESS_AGENTS.includes(agent)) return undefined
  return `このツールはハーネスの司令塔（${HARNESS_AGENTS.join(" / ")} エージェント）だけが使えます（呼び出し元: ${agent}）。/dev を実行するか、エージェントを harness に切り替えてください。`
}

// .env や秘密鍵のパターン。.env.example は秘密情報を含まない前提で読み書きを許可する
const SECRET_FILES: [pattern: string, action: PermissionRule["action"]][] = [
  ["*.env", "deny"],
  ["*.env.*", "deny"],
  ["*.env.example", "allow"],
  ["*id_rsa*", "deny"],
  ["*.pem", "deny"],
  ["*.key", "deny"],
]

// 子セッションの権限の最後に付ける拒否。後のルールが優先されるので、工程が渡す広い編集の許可でも上書きされない
export const SECRET_DENY: PermissionRule[] = ["read", "edit"].flatMap((permission) =>
  SECRET_FILES.map(([pattern, action]) => ({ permission, pattern, action })),
)

// opencode のワイルドカードと同じく、* はパスの区切りを含む任意の文字列、? は 1 文字
const wildcard = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s")

// 秘密情報のファイルか。権限と同じく、一致した最後のパターンで決める
export function isSecretPath(path: string): boolean {
  return SECRET_FILES.findLast(([pattern]) => wildcard(pattern).test(path))?.[1] === "deny"
}

// grep ツールの結果から、秘密情報のファイルの行を取り除く。
// grep の権限は検索語に対して評価されるため、read を拒否しても .env の中身が grep で読めてしまう（PR #43 で確認）
// 出力の形式は opencode の tool/grep.ts: 「Found N matches」、空行で区切った「<パス>:」と「  Line N: ...」の塊、末尾の注記
export function filterGrepOutput(output: string): string {
  const [header, ...rest] = output.split("\n")
  const found = header?.match(/^Found \d+ matches(.*)$/)
  if (!found) return output

  const blocks: { path: string; lines: string[] }[] = []
  const trailer: string[] = []
  for (const line of rest) {
    if (line.startsWith("  Line ") && blocks.length && !trailer.length) blocks.at(-1)!.lines.push(line)
    else if (line.endsWith(":") && !trailer.length) blocks.push({ path: line.slice(0, -1), lines: [] })
    else if (line.trim()) trailer.push(line)
  }
  const kept = blocks.filter((b) => !isSecretPath(b.path))
  if (kept.length === blocks.length) return output

  const removed = blocks.filter((b) => isSecretPath(b.path)).reduce((n, b) => n + b.lines.length, 0)
  const note = `（秘密情報のファイル（.env など）の一致 ${removed} 件を除外しました）`
  const count = kept.reduce((n, b) => n + b.lines.length, 0)
  if (!count) return `No files found\n\n${note}`
  return [
    `Found ${count} matches${found[1]}`,
    ...kept.flatMap((b, i) => [...(i ? [""] : []), `${b.path}:`, ...b.lines]),
    ...(trailer.length ? ["", ...trailer] : []),
    "",
    note,
  ].join("\n")
}
