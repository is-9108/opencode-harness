// JUnit XML の解析。対象は vitest の出力を基準にし、自己終了タグ・skipped・error も扱う
// XML のライブラリには頼らず、testcase 要素だけを取り出す（ハーネスは依存を増やさない）

export type TestCaseResult = {
  name: string
  file: string
  status: "passed" | "failed" | "skipped"
  failureType?: string
  message?: string
  // テストファイル自体を読み込めなかった（import エラー・構文エラー）。vitest はファイル名をテスト名にして失敗を報告する
  loadError: boolean
}

const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
const FAILURE = /<(failure|error)\b([^>]*?)(?:\/>|>)/
const ANSI = /\x1b\[[0-9;]*m|\[[0-9;]*m/g

export function parseJUnit(xml: string): TestCaseResult[] {
  const results: TestCaseResult[] = []
  for (const m of xml.matchAll(TESTCASE)) {
    const attrs = parseAttributes(m[1] ?? "")
    const body = m[2] ?? ""
    const name = attrs.name ?? ""
    const file = attrs.classname ?? attrs.file ?? ""
    const failure = body.match(FAILURE)
    if (failure) {
      const f = parseAttributes(failure[2] ?? "")
      results.push({
        name,
        file,
        status: "failed",
        failureType: f.type,
        message: f.message?.replace(ANSI, ""),
        loadError: name === file,
      })
    } else if (/<skipped\b/.test(body)) {
      results.push({ name, file, status: "skipped", loadError: false })
    } else {
      results.push({ name, file, status: "passed", loadError: false })
    }
  }
  return results
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of source.matchAll(/([\w:-]+)="([^"]*)"/g)) if (m[1]) attrs[m[1]] = unescape(m[2] ?? "")
  return attrs
}

function unescape(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}
