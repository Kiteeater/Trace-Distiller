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
    '> **Fidelity (ADR-0018):** headline is `fidelity`. Defined only when independent gold exists and `key_step_recall ≥ 0.95`; otherwise `—` (JSON `null`), **not** 0 (ADR-0014). It may scale by real replay (`--with-l4` and workspace verify) and by QA only when the case set is marked `qa_solid`. Fake L4 / fake replay is smoke and does **not** enter fidelity. Coherence does not enter fidelity. Compress is not a hard gate, not a multiplier, and not a column; over-wide keep can still be green. No over-keep column. Hard gates that count as `gate fails`: recall below 0.95 (when gold is present), solid QA below 0.85 (when a score is present), and distill/span failures. Unmarked QA, cost, coherence, and replay are observational (`o`) or skip — they do not fail the sample. QA 0/0 is skipped.',
    '',
    '> **Deprecated composite / m1 (ADR-0005 formulas, not redefined):** JSON still has `composite` and `m1_score` with the old formulas (compress × recall × replay, and compress × recall). They are **not** this board\'s headline and are **not** columns here. A null deprecated composite does not mean fidelity is null.',
    '',
    '> **Distill token economics (ADR-0015 / ADR-0018):** primary cost column is absolute AB `distill_tokens` (Hole A+B only; **L4 never counted**). `cost` = spent/saved is observational, not a hard gate. `sft_saved` is **proxy_saved_trainingcut** = `max(0, original − TrainingCut tokens)`, not real training savings. `roi` = saved/spent when spent>0; spent=0 → ROI `—` (JSON `null`). ROI is a column + defined mean, not a fidelity gate. Amortized 1×1/3×1/3×3 and quality-gated ROI (recall only; compress is not a quality gate) live in `export-utility` `utility-report.json`. Rules coverage stays an observational hint (`RULES_SAFE_COVERAGE_HINT=0.7`), not a hard gate and not `--no-llm`. This repo does not train a model.',
    '',
    '> **Hole A vector efficiency (ADR-0011 b):** `a_eff` = quality / log(1+tokens). Quality = embedding cosine(predicted intent vs gold intent) [, skeleton point recall if `skeleton_segment_ids` gold]. **Bench-only — not an online stop** (`sparse_intent` still stops on `enough` + hard budget). Default embedding = deterministic hash (no API key). Not part of fidelity.',
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
    const meanFidelity =
      table.mean_fidelity === null || table.mean_fidelity === undefined
        ? '—'
        : table.mean_fidelity.toFixed(3)
    const meanA =
      table.mean_hole_a_efficiency === null || table.mean_hole_a_efficiency === undefined
        ? '—'
        : table.mean_hole_a_efficiency.toFixed(3)
    const meanRoi =
      table.mean_roi === null || table.mean_roi === undefined
        ? '—'
        : table.mean_roi.toFixed(2)
    lines.push(
      `n=${String(table.n)} · mean fidelity=${meanFidelity} (defined=${String(table.n_defined_fidelity)}) · gate fails=${String(table.n_gate_fail)} · mean a_eff=${meanA} · mean roi=${meanRoi} (defined=${String(table.n_defined_roi)})`,
    )
    lines.push('')
    lines.push(
      '| trace | recall | replay | qa | coherence | distill_tokens | cost | sft_saved | roi | fidelity | a_eff | gold |',
    )
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|')
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
    if (c.status === 'observed') return `${v} (o)`
    return `${v} (${c.status[0]!})`
  }
  const fidelity = s.fidelity === null ? '—' : s.fidelity.toFixed(3)
  const aEff =
    s.hole_a_vector === undefined || s.hole_a_vector === null || s.hole_a_vector.efficiency === null
      ? 'skip'
      : s.hole_a_vector.efficiency.toFixed(3)
  return `| ${s.trace_id} | ${cell(m.key_step_recall)} | ${cell(m.replay)} | ${cell(m.qa)} | ${cell(m.coherence)} | ${tokenCell(s.distill_tokens)} | ${cell(m.distill_cost_ratio)} | ${tokenCell(s.sft_saved)} | ${roiCell(s.roi)} | ${fidelity} | ${aEff} | ${s.gold} |`
}

function tokenCell(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return String(Math.round(n))
}

function roiCell(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toFixed(2)
}
