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
 * Quality gate: if process gates fail, do not treat saved as free lunch.
 * Missing recall/compress → fail-closed (gated roi null) unless quality_ok: true.
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
  if (input.compression_ratio === null || input.compression_ratio === undefined) {
    return { roi: null, quality_ok: false, reason: 'missing compression_ratio' }
  }
  if (input.key_step_recall < BENCHMARK_PASS.key_step_recall_min) {
    return {
      roi: null,
      quality_ok: false,
      reason: `key_step_recall ${String(input.key_step_recall)} < ${String(BENCHMARK_PASS.key_step_recall_min)}`,
    }
  }
  if (input.compression_ratio > BENCHMARK_PASS.compression_ratio_max) {
    return {
      roi: null,
      quality_ok: false,
      reason: `compression_ratio ${String(input.compression_ratio)} > ${String(BENCHMARK_PASS.compression_ratio_max)}`,
    }
  }
  return { roi: input.roi, quality_ok: true }
}
