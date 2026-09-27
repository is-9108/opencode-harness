// エージェントをまたいで共通の権限と、ハーネスのツールを使えるエージェントの制限（計画 9 章）
import type { PermissionRule } from "./session.ts"

// ハーネスのツール（harness_*）を使えるエージェント。司令塔だけに限る（M2 で harness-fix を加える）
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
