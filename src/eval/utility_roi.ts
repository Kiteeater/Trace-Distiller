import { BENCHMARK_PASS } from '../constant/compression.ts'

/** students × epochs amortization of single-reuse ROI (or of saved/spent). */
export function amortizeRoi(roi: number | null, students: number, epochs: number): number | null {
  if (roi === null) return null
  const n = roi * students * epochs
  return Number.isFinite(n) ? n : null
}

/** Documented ADR-0015 scenarios: 1×1 / 3×1 / 3×3 (students × epochs). */
export function amortizedRoiScenarios(roi: number | null): {
  '1x1': number | null
  '3x1': number | null
  '3x3': number | null
} {
  return {
    '1x1': amortizeRoi(roi, 1, 1),
    '3x1': amortizeRoi(roi, 3, 1),
    '3x3': amortizeRoi(roi, 3, 3),
  }
}

export interface QualityGatedRoiInput {
  roi: number | null
  key_step_recall: number | null | undefined
  /**
   * Ignored by the gate (ADR-0018). Callers may still pass the measured ratio.
   */
  compression_ratio: number | null | undefined
  /** optional: skeleton protect / other fail flags; true skips metric checks (unit tests). */
  quality_ok?: boolean
}

export interface QualityGatedRoi {
  roi: number | null
  quality_ok: boolean
  reason?: string
}

/**
 * Quality gate for ROI (ADR-0015, compress clause retired by ADR-0018).
 * Missing or low recall → fail-closed (gated roi null) unless quality_ok: true.
 * `compression_ratio` is ignored: over-wide keep is not watched. Cost ratio is
 * not a gate here either.
 */
export function qualityGatedRoi(input: QualityGatedRoiInput): QualityGatedRoi {
  if (input.quality_ok === false) {
    return { roi: null, quality_ok: false, reason: 'quality_ok=false' }
  }
  if (input.quality_ok === true) {
    return { roi: input.roi, quality_ok: true }
  }

  if (input.key_step_recall === null || input.key_step_recall === undefined) {
    return { roi: null, quality_ok: false, reason: 'missing key_step_recall' }
  }
  if (input.key_step_recall < BENCHMARK_PASS.key_step_recall_min) {
    return {
      roi: null,
      quality_ok: false,
      reason: `key_step_recall ${String(input.key_step_recall)} < ${String(BENCHMARK_PASS.key_step_recall_min)}`,
    }
  }
  return { roi: input.roi, quality_ok: true }
}
