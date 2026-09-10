import type { BenchmarkReport, ScoredSample } from './benchmark.ts'

/** 人类可读分档榜。禁止输出跨档总分。 */
export function renderScoreboardMarkdown(input: {
  dir: string
  mode: string
  l4: boolean
  bins: BenchmarkReport['bins']
}): string {
  const lines: string[] = [
    '# Trace-Distiller Benchmark Scoreboard',
    '',
    `- datasets: \`${input.dir}\``,
    `- distill mode: \`${input.mode}\``,
    `- L4 qa/replay/coherence: ${input.l4 ? 'attempted' : 'skipped'}`,
    '',
    'Tracks are scored separately and **never averaged**.',
    '',
    '> **M1 vs composite:** `m1_score` = 压缩率得分 × 关键步召回（M1 硬门禁）。`composite` 仍要求六项全过（含 cost≤0.3）。短 trace 真 mint 常因处理成本比偏高使 `composite=0`；compress+recall 过时看 `m1_score` 判断 M1 是否成功。',
    '',
  ]

  for (const bin of ['short', 'long', 'multi_dead_end'] as const) {
    const table = input.bins[bin]
    lines.push(`## ${bin}`)
    lines.push('')
    if (table.n === 0) {
      lines.push('_no samples_')
      lines.push('')
      continue
    }
    const mean =
      table.mean_composite === null || table.mean_composite === undefined
        ? '—'
        : table.mean_composite.toFixed(2)
    const meanM1 =
      table.mean_m1_score === null || table.mean_m1_score === undefined
        ? '—'
        : table.mean_m1_score.toFixed(2)
    lines.push(`n=${table.n} · mean composite=${mean} · mean m1=${meanM1}`)
    lines.push('')
    lines.push(
      '| trace | compress | recall | replay | qa | coherence | cost | composite | m1 | gold |',
    )
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---|')
    for (const s of table.samples) {
      lines.push(row(s))
    }
    const noted = table.samples.filter((s) => s.notes !== undefined && s.notes.length > 0)
    if (noted.length > 0) {
      lines.push('### notes')
      lines.push('')
      for (const s of noted) {
        for (const n of s.notes ?? []) {
          lines.push(`- \`${s.trace_id}\`: ${n}`)
        }
      }
      lines.push('')
    }
    lines.push('')
  }
  return lines.join('\n')
}

function row(s: ScoredSample): string {
  const m = s.metrics
  const cell = (c: { value: number | null; status: string }) => {
    if (c.status === 'skipped' || c.value === null) return 'skip'
    const v = typeof c.value === 'number' ? c.value.toFixed(3) : String(c.value)
    return `${v} (${c.status[0]!})`
  }
  const comp = s.composite === null ? '—' : s.composite.toFixed(2)
  const m1 = s.m1_score === null ? '—' : s.m1_score.toFixed(2)
  return `| ${s.trace_id} | ${cell(m.compression_ratio)} | ${cell(m.key_step_recall)} | ${cell(m.replay)} | ${cell(m.qa)} | ${cell(m.coherence)} | ${cell(m.distill_cost_ratio)} | ${comp} | ${m1} | ${s.gold} |`
}
