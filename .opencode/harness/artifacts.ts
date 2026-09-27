// 成果物（md）の frontmatter の読み書き（計画 2 章の基本原則 4: 完了マーカー）
// 対応するのは「key: value」の 1 行形式と、「key:」の次の行から続く「  - item」のリスト（値は「, 」でつなぐ）。
// LLM はリストの項目をリスト形式で書くことがある（#36 の実機で確認）

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function readFrontmatter(content: string): Record<string, string> {
  const block = content.match(FRONTMATTER)?.[1]
  if (!block) return {}
  const data: Record<string, string> = {}
  let listKey: string | undefined
  for (const line of block.split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && listKey) {
      const value = stripComment(item[1] ?? "").replace(/^(["'])(.*)\1$/, "$2")
      data[listKey] = data[listKey] ? `${data[listKey]}, ${value}` : value
      continue
    }
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (m?.[1]) {
      data[m[1]] = stripComment(m[2] ?? "")
      listKey = data[m[1]] === "" ? m[1] : undefined
    }
  }
  return data
}

// YAML と同じく、引用符の外で、空白の後に続く # 以降をコメントとして取り除く
function stripComment(value: string): string {
  const quoted = value.match(/^("[^"]*"|'[^']*')/)
  if (quoted?.[1]) return quoted[1]
  const i = value.search(/\s#/)
  return (i < 0 ? value : value.slice(0, i)).trim()
}

// frontmatter の 1 項目を書き換える。項目がなければ末尾に足し、frontmatter がなければ作る
export function setFrontmatter(content: string, key: string, value: string): string {
  const m = content.match(FRONTMATTER)
  if (!m?.[1]) return `---\n${key}: ${value}\n---\n${content}`
  const lines = m[1].split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (i >= 0) lines[i] = `${key}: ${value}`
  else lines.push(`${key}: ${value}`)
  return content.replace(FRONTMATTER, `---\n${lines.join("\n")}\n---\n`)
}
