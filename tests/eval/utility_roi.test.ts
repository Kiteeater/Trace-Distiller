import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BENCHMARK_PASS } from '../../src/constant/compression.ts'
import {
  amortizeRoi,
  amortizedRoiScenarios,
  qualityGatedRoi,
} from '../../src/eval/utility_roi.ts'

describe('amortizeRoi', () => {
  it('amortizeRoi(2, 3, 3) === 18; null stays null', () => {
    assert.equal(amortizeRoi(2, 3, 3), 18)
    assert.equal(amortizeRoi(null, 3, 3), null)
    assert.equal(amortizeRoi(2, 1, 1), 2)
  })
})

describe('amortizedRoiScenarios', () => {
  it('scenarios object keys 1x1 / 3x1 / 3x3', () => {
    const s = amortizedRoiScenarios(2)
    assert.deepEqual(Object.keys(s).sort(), ['1x1', '3x1', '3x3'])
    assert.equal(s['1x1'], 2)
    assert.equal(s['3x1'], 6)
    assert.equal(s['3x3'], 18)
    const n = amortizedRoiScenarios(null)
    assert.equal(n['1x1'], null)
    assert.equal(n['3x1'], null)
    assert.equal(n['3x3'], null)
  })
})

describe('qualityGatedRoi', () => {
  it('quality fail is low recall; compress does not null gated roi', () => {
    const recallFail = qualityGatedRoi({
      roi: 4,
      key_step_recall: 0.5,
      compression_ratio: 0.2,
    })
    assert.equal(recallFail.quality_ok, false)
    assert.equal(recallFail.roi, null)
    assert.match(recallFail.reason ?? '', /key_step_recall/)

    const wideKeep = qualityGatedRoi({
      roi: 4,
      key_step_recall: 1,
      compression_ratio: 0.5,
    })
    assert.equal(wideKeep.quality_ok, true)
    assert.equal(wideKeep.roi, 4)
  })

  it('missing recall fails closed; missing compress does not', () => {
    const missing = qualityGatedRoi({
      roi: 4,
      key_step_recall: null,
      compression_ratio: 0.2,
    })
    assert.equal(missing.quality_ok, false)
    assert.equal(missing.roi, null)
    assert.match(missing.reason ?? '', /missing key_step_recall/)

    const noCompress = qualityGatedRoi({
      roi: 4,
      key_step_recall: 1,
      compression_ratio: undefined,
    })
    assert.equal(noCompress.quality_ok, true)
    assert.equal(noCompress.roi, 4)
  })

  it('quality pass → roi preserved', () => {
    const ok = qualityGatedRoi({
      roi: 4,
      key_step_recall: BENCHMARK_PASS.key_step_recall_min,
      compression_ratio: BENCHMARK_PASS.compression_ratio_max,
    })
    assert.equal(ok.quality_ok, true)
    assert.equal(ok.roi, 4)
    assert.equal(ok.reason, undefined)
  })

  it('explicit quality_ok true override passes through even if metrics missing', () => {
    const ok = qualityGatedRoi({
      roi: 2,
      key_step_recall: null,
      compression_ratio: undefined,
      quality_ok: true,
    })
    assert.equal(ok.quality_ok, true)
    assert.equal(ok.roi, 2)
  })
})
