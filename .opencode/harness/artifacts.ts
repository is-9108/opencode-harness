// 成果物（md）の frontmatter の読み書き（計画 2 章の基本原則 4: 完了マーカー）
// 対応するのは「key: value」の 1 行形式だけ。成果物の frontmatter はハーネスの雛形で決めているので、それで足りる

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function readFrontmatter(content: string): Record<string, string> {
  const block = content.match(FRONTMATTER)?.[1]
  if (!block) return {}
  const data: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*?)\s*(#.*)?$/)
    if (m?.[1]) data[m[1]] = m[2] ?? ""
  }
  return data
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
