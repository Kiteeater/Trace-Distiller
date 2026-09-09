/** 把 JSONL 文本拆成记录。坏行抛错，由调用方映射为 unparseable。 */
export function parseJsonlText(text: string): unknown[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const rows: unknown[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      rows.push(JSON.parse(trimmed) as unknown)
    } catch {
      throw new Error(`invalid JSONL at line ${i + 1}`)
    }
  }
  return rows
}
