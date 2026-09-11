/**
 * Tool mask（ADR-0010）：工具完整 payload 不得原样回灌下一轮 agent prompt。
 * 只返回 summarize / truncate / structure；全量可进 warrant / training store。
 */

export const TOOL_MASK_DEFAULT_MAX_CHARS = 480

export interface MaskedToolResult {
  /** 可安全写入下一轮 agent prompt 的短文本。 */
  summary: string
  truncated: boolean
  raw_byte_len: number
  /** 结构化摘要字段（无全文）。 */
  structure: Record<string, unknown>
}

export interface MaskToolResultOpts {
  maxChars?: number
  /** 工具名，用于已知形状的结构化摘要。 */
  toolName?: string
}

/**
 * 将任意工具原始结果掩码为 agent 可读摘要。
 * - 长字符串截断并标注 truncated
 * - 已知洞工具形状（read_segment / label_segment / check_continuity / keep_segment / apply_rules_hint）只保留 id / 标签 / 分数 / 未决预览等，不回传全文
 * - 未知对象保留浅层标量键，嵌套大字段替换为长度提示
 */
export function maskToolResult(raw: unknown, opts: MaskToolResultOpts = {}): MaskedToolResult {
  const maxChars = clampMax(opts.maxChars ?? TOOL_MASK_DEFAULT_MAX_CHARS)
  const toolName = opts.toolName
  const raw_byte_len = byteLen(raw)

  if (toolName === 'read_segment' || isReadSegmentShape(raw)) {
    return maskReadSegment(raw, maxChars, raw_byte_len)
  }
  if (toolName === 'label_segment' || isLabelSegmentShape(raw)) {
    return maskLabelSegment(raw, raw_byte_len)
  }
  if (toolName === 'check_continuity' || isContinuityShape(raw)) {
    return maskContinuity(raw, raw_byte_len)
  }
  if (toolName === 'keep_segment' || isKeepSegmentShape(raw)) {
    return maskKeepSegment(raw, raw_byte_len)
  }
  if (toolName === 'apply_rules_hint' || isApplyRulesHintShape(raw)) {
    return maskApplyRulesHint(raw, maxChars, raw_byte_len)
  }

  if (typeof raw === 'string') {
    return maskString(raw, maxChars, raw_byte_len)
  }

  if (raw === null || raw === undefined) {
    return {
      summary: raw === null ? 'null' : 'undefined',
      truncated: false,
      raw_byte_len,
      structure: { kind: 'empty', value: raw === null ? null : 'undefined' },
    }
  }

  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return {
      summary: String(raw),
      truncated: false,
      raw_byte_len,
      structure: { kind: 'scalar', value: raw },
    }
  }

  if (Array.isArray(raw)) {
    const preview = raw.slice(0, 8).map((item) => shallowPreview(item, 80))
    const summaryBase = `array(len=${String(raw.length)}) ${JSON.stringify(preview)}`
    return finalizeSummary(summaryBase, maxChars, raw_byte_len, {
      kind: 'array',
      length: raw.length,
      preview,
    })
  }

  if (typeof raw === 'object') {
    const rec = raw as Record<string, unknown>
    // pi-style { content: [{ type:'text', text }] }
    const textFromContent = extractContentText(rec)
    if (textFromContent !== undefined) {
      const inner = maskString(textFromContent, maxChars, byteLen(textFromContent))
      return {
        ...inner,
        raw_byte_len,
        structure: { kind: 'content_text', ...inner.structure, details: shallowPreview(rec.details, 40) },
      }
    }
    const structure = shallowObject(rec, maxChars)
    const summaryBase = `object keys=${Object.keys(structure).join(',')} ${JSON.stringify(structure)}`
    return finalizeSummary(summaryBase, maxChars, raw_byte_len, {
      kind: 'object',
      ...structure,
    })
  }

  return maskString(String(raw), maxChars, raw_byte_len)
}

/** 将掩码结果压成单行 prompt 片段。 */
export function formatMaskedForPrompt(masked: MaskedToolResult): string {
  return masked.summary
}

function maskReadSegment(raw: unknown, maxChars: number, raw_byte_len: number): MaskedToolResult {
  const rec = asRecord(raw) ?? {}
  const segment_id = typeof rec.segment_id === 'string' ? rec.segment_id : undefined
  const text = typeof rec.text === 'string' ? rec.text : typeof rec === 'object' ? undefined : undefined
  const textLen = typeof text === 'string' ? text.length : 0
  const head =
    typeof text === 'string' && text.length > 0
      ? text.slice(0, Math.min(120, maxChars))
      : undefined
  const structure: Record<string, unknown> = {
    kind: 'read_segment',
    ...(segment_id !== undefined ? { segment_id } : {}),
    focus: rec.focus ?? 'full',
    text_chars: textLen,
    ...(head !== undefined ? { head } : {}),
  }
  const summary = segment_id
    ? `read_segment ${segment_id} text_chars=${String(textLen)}${head !== undefined ? ` head=${JSON.stringify(head)}` : ''}`
    : `read_segment text_chars=${String(textLen)}`
  return {
    summary: truncate(summary, maxChars).text,
    truncated: textLen > 120 || summary.length > maxChars,
    raw_byte_len,
    structure,
  }
}

function maskLabelSegment(raw: unknown, raw_byte_len: number): MaskedToolResult {
  const rec = asRecord(raw) ?? {}
  const structure: Record<string, unknown> = {
    kind: 'label_segment',
    segment_id: rec.segment_id,
    label: rec.label,
    confidence: rec.confidence,
  }
  const summary = `label_segment ${String(rec.segment_id)}=${String(rec.label)}@${String(rec.confidence)}`
  return { summary, truncated: false, raw_byte_len, structure }
}

function maskContinuity(raw: unknown, raw_byte_len: number): MaskedToolResult {
  const rec = asRecord(raw) ?? {}
  const reason =
    typeof rec.reason === 'string' ? truncate(rec.reason, 120).text : undefined
  const structure: Record<string, unknown> = {
    kind: 'check_continuity',
    left_id: rec.left_id,
    right_id: rec.right_id,
    reachable: rec.reachable,
    score: rec.score,
    ...(reason !== undefined ? { reason } : {}),
  }
  const summary = `check_continuity ${String(rec.left_id)}->${String(rec.right_id)} score=${String(rec.score)} reachable=${String(rec.reachable)}`
  return { summary, truncated: typeof rec.reason === 'string' && rec.reason.length > 120, raw_byte_len, structure }
}

function maskKeepSegment(raw: unknown, raw_byte_len: number): MaskedToolResult {
  const rec = asRecord(raw) ?? {}
  const structure: Record<string, unknown> = {
    kind: 'keep_segment',
    segment_id: rec.segment_id,
    confidence: rec.confidence,
  }
  const summary = `keep_segment ${String(rec.segment_id)}@${String(rec.confidence ?? 1)}`
  return { summary, truncated: false, raw_byte_len, structure }
}

function maskApplyRulesHint(raw: unknown, maxChars: number, raw_byte_len: number): MaskedToolResult {
  const rec = asRecord(raw) ?? {}
  const unresolved = Array.isArray(rec.unresolved_ids)
    ? rec.unresolved_ids.filter((id): id is string => typeof id === 'string').slice(0, 24)
    : []
  const structure: Record<string, unknown> = {
    kind: 'apply_rules_hint',
    applied: rec.applied === true,
    resolved_count: typeof rec.resolved_count === 'number' ? rec.resolved_count : 0,
    unresolved_count: unresolved.length,
    unresolved_ids_preview: unresolved,
  }
  const summaryBase = `apply_rules_hint applied=${String(structure.applied)} resolved=${String(structure.resolved_count)} unresolved=${String(unresolved.length)} ids=${JSON.stringify(unresolved)}`
  return finalizeSummary(summaryBase, maxChars, raw_byte_len, structure)
}

function maskString(raw: string, maxChars: number, raw_byte_len: number): MaskedToolResult {
  const { text, truncated } = truncate(raw, maxChars)
  return {
    summary: text,
    truncated,
    raw_byte_len,
    structure: { kind: 'string', chars: raw.length },
  }
}

function finalizeSummary(
  summaryBase: string,
  maxChars: number,
  raw_byte_len: number,
  structure: Record<string, unknown>,
): MaskedToolResult {
  const { text, truncated } = truncate(summaryBase, maxChars)
  return { summary: text, truncated, raw_byte_len, structure }
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true }
}

function clampMax(n: number): number {
  if (!Number.isFinite(n) || n < 32) return 32
  return Math.floor(n)
}

function byteLen(value: unknown): number {
  try {
    return Buffer.byteLength(
      typeof value === 'string' ? value : JSON.stringify(value) ?? String(value),
      'utf8',
    )
  } catch {
    return String(value).length
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function isReadSegmentShape(raw: unknown): boolean {
  const rec = asRecord(raw)
  return rec !== undefined && typeof rec.segment_id === 'string' && typeof rec.text === 'string'
}

function isLabelSegmentShape(raw: unknown): boolean {
  const rec = asRecord(raw)
  return (
    rec !== undefined &&
    typeof rec.segment_id === 'string' &&
    typeof rec.label === 'string' &&
    typeof rec.confidence === 'number'
  )
}

function isContinuityShape(raw: unknown): boolean {
  const rec = asRecord(raw)
  return (
    rec !== undefined &&
    typeof rec.left_id === 'string' &&
    typeof rec.right_id === 'string' &&
    typeof rec.score === 'number'
  )
}

function isKeepSegmentShape(raw: unknown): boolean {
  const rec = asRecord(raw)
  if (rec === undefined) return false
  if (rec.kind === 'keep_segment' && typeof rec.segment_id === 'string') return true
  // ACK shape from keep_segment execute: segment_id + optional confidence, no label/text.
  if (typeof rec.segment_id !== 'string') return false
  if (typeof rec.label === 'string') return false
  if (typeof rec.text === 'string') return false
  if (typeof rec.left_id === 'string') return false
  if (Array.isArray(rec.unresolved_ids)) return false
  return typeof rec.confidence === 'number' || rec.confidence === undefined
}

function isApplyRulesHintShape(raw: unknown): boolean {
  const rec = asRecord(raw)
  return (
    rec !== undefined &&
    (rec.kind === 'apply_rules_hint' ||
      (typeof rec.resolved_count === 'number' && Array.isArray(rec.unresolved_ids)))
  )
}

function extractContentText(rec: Record<string, unknown>): string | undefined {
  const content = rec.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

function shallowObject(rec: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const keys = Object.keys(rec).slice(0, 24)
  for (const key of keys) {
    out[key] = shallowPreview(rec[key], Math.min(120, maxChars))
  }
  return out
}

function shallowPreview(value: unknown, maxChars: number): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncate(value, maxChars).text
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return { kind: 'array', length: value.length }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object)
    return { kind: 'object', keys: keys.slice(0, 12), key_count: keys.length }
  }
  return truncate(String(value), maxChars).text
}
