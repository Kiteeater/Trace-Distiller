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
    '> **Defined composite / m1 (ADR-0014):** 单项列始终显示 value + pass/fail/skip。`composite` / `m1_score` **仅当该分所需门槛全过且有数值时才定义**；否则 `—`（JSON `null`），**不是** 0。m1 所需：compression + key_step_recall。composite 所需：现行六项（**short 档或 original_tokens≤25k 的 cost 只报不分**；仍不计 L4）。QA 0/0 视为 skipped。档均值只对 defined 样本；`gate fails` 计任一项 metric `fail` 的样本。公式在 defined 时不变（ADR-0005）：composite = 压缩率得分 × 召回 × 重放；m1 = 压缩率得分 × 召回。',
    '',
    '> **Distill token economics (ADR-0015):** 主比 `cost` = `distill_tokens / sft_saved`（Hole A+B only；**L4 never counted**）。ROI = saved/spent when spent>0；`ROI > 1` ⇔ `cost < 1` ⇔ token-profitable for a single reuse。spent=0 → ROI `—`（JSON `null`，不把 Infinity 灌进均值）。ROI 是 **列 + defined 均值**，**不是** composite/m1 门禁。',
    '',
    '> **Hole A vector efficiency (ADR-0011 b):** `a_eff` = quality / log(1+tokens). Quality = embedding cosine(predicted intent vs gold intent) [, skeleton point recall if `skeleton_segment_ids` gold]. **Bench-only — not an online stop** (`sparse_intent` still stops on `enough` + hard budget). Default embedding = deterministic hash (no API key). Not part of m1/composite.',
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
    const meanA =
      table.mean_hole_a_efficiency === null || table.mean_hole_a_efficiency === undefined
        ? '—'
        : table.mean_hole_a_efficiency.toFixed(3)
    const meanRoi =
      table.mean_roi === null || table.mean_roi === undefined
        ? '—'
        : table.mean_roi.toFixed(2)
    lines.push(
      `n=${String(table.n)} · mean composite=${mean} (defined=${String(table.n_defined_composite)}) · mean m1=${meanM1} (defined=${String(table.n_defined_m1)}) · gate fails=${String(table.n_gate_fail)} · mean a_eff=${meanA} · mean roi=${meanRoi} (defined=${String(table.n_defined_roi)})`,
    )
    lines.push('')
    lines.push(
      '| trace | compress | recall | replay | qa | coherence | cost | distill_tokens | sft_saved | roi | composite | m1 | a_eff | gold |',
    )
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|')
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
  const aEff =
    s.hole_a_vector === undefined || s.hole_a_vector === null || s.hole_a_vector.efficiency === null
      ? 'skip'
      : s.hole_a_vector.efficiency.toFixed(3)
  return `| ${s.trace_id} | ${cell(m.compression_ratio)} | ${cell(m.key_step_recall)} | ${cell(m.replay)} | ${cell(m.qa)} | ${cell(m.coherence)} | ${cell(m.distill_cost_ratio)} | ${tokenCell(s.distill_tokens)} | ${tokenCell(s.sft_saved)} | ${roiCell(s.roi)} | ${comp} | ${m1} | ${aEff} | ${s.gold} |`
}

function tokenCell(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return String(Math.round(n))
}

function roiCell(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toFixed(2)
}
