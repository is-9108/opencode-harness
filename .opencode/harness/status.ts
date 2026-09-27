// harness_status ツールが返す文章を組み立てる
import { CONFIG_FILE, type LoadResult } from "./config.ts"

export function formatStatus(load: LoadResult): string {
  switch (load.status) {
    case "missing":
      return [
        `設定ファイル ${CONFIG_FILE} がありません（${load.path}）。`,
        `雛形 ${load.examplePath} をコピーして、モデル・チェック・テストファイルの場所を設定してください。`,
      ].join("\n")
    case "invalid":
      return [`設定ファイルに誤りがあります（${load.path}）:`, ...load.errors.map((e) => `- ${e}`)].join("\n")
    case "ok":
      return [
        "run はありません。",
        ...(load.warnings.length > 0 ? ["", "設定の警告:", ...load.warnings.map((w) => `- ${w}`)] : []),
      ].join("\n")
  }
}
