import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DeterministicHashEmbedding,
  HttpEmbeddingProvider,
  cosineAsQuality,
  cosineSimilarity,
  efficiencyCost,
  holeAQuality,
  predictedHoleAText,
  resolveEmbeddingProvider,
  scoreHoleAVectorEfficiency,
  skeletonPointRecall,
  summarizeSkeletonPoints,
  vectorEfficiencyComposite,
} from '../../src/eval/vector_efficiency.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const evalDir = join(repoRoot, 'src/eval')
const sessionsDir = join(repoRoot, 'src/agent/sessions')

describe('cosineSimilarity', () => {
  it('identical vectors → 1; orthogonal → 0; zero → 0', () => {
    assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1)
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0)
    assert.equal(cosineSimilarity([1], [1, 2]), 0)
    assert.ok(cosineSimilarity([1, 1], [1, 0]) > 0.7)
  })

  it('cosineAsQuality clamps to [0, 1]', () => {
    assert.equal(cosineAsQuality(1), 1)
    assert.equal(cosineAsQuality(0.5), 0.5)
    assert.equal(cosineAsQuality(-0.2), 0)
    assert.equal(cosineAsQuality(1.5), 1)
  })
})

describe('vectorEfficiencyComposite', () => {
  it('quality / log(1 + tokens); more tokens same quality → lower score', () => {
    const q = 0.8
    const cheap = vectorEfficiencyComposite(q, 10)
    const dear = vectorEfficiencyComposite(q, 1000)
    assert.ok(cheap > dear, `cheap=${cheap} dear=${dear}`)
    assert.equal(cheap, q / Math.log1p(10))
    assert.equal(dear, q / Math.log1p(1000))
  })

  it('zero cost returns quality (no div-by-zero)', () => {
    assert.equal(vectorEfficiencyComposite(0.9, 0), 0.9)
  })

  it('efficiencyCost prefers tokens, else segments', () => {
    assert.equal(efficiencyCost(40, 3), 40)
    assert.equal(efficiencyCost(0, 3), 3)
    assert.equal(efficiencyCost(0, 0), 0)
  })
})

describe('DeterministicHashEmbedding', () => {
  it('same text → cosine 1; different text → lower; no network', async () => {
    const embedder = new DeterministicHashEmbedding()
    const a = await embedder.embed('Fix the failing test in add.ts so 1+1 equals 2.')
    const b = await embedder.embed('Fix the failing test in add.ts so 1+1 equals 2.')
    const c = await embedder.embed('Bake sourdough bread with a long cold ferment.')
    assert.equal(embedder.id, 'deterministic_hash')
    assert.equal(cosineSimilarity(a, b), 1)
    assert.ok(cosineSimilarity(a, c) < cosineSimilarity(a, b))
  })
})

describe('skeleton recall + quality mix', () => {
  it('skeletonPointRecall is predicted ∩ gold / gold', () => {
    assert.equal(
      skeletonPointRecall({
        gold_segment_ids: ['s1', 's2', 's3'],
        predicted_segment_ids: ['s1', 's9'],
      }),
      1 / 3,
    )
    assert.equal(
      skeletonPointRecall({ gold_segment_ids: [], predicted_segment_ids: ['s1'] }),
      0,
    )
  })

  it('holeAQuality averages cosine and recall when both exist', () => {
    assert.equal(holeAQuality({ cosine: 1, skeleton_recall: 0.5 }), 0.75)
    assert.equal(holeAQuality({ cosine: 0.8, skeleton_recall: null }), 0.8)
    assert.equal(holeAQuality({ cosine: null, skeleton_recall: 1 }), 1)
    assert.equal(holeAQuality({ cosine: null, skeleton_recall: null }), null)
  })

  it('summarizeSkeletonPoints / predictedHoleAText join intent + skeleton', () => {
    const summary = summarizeSkeletonPoints([
      { kind: 'turning_point', note: 'root cause', segment_ids: ['s0006'] },
    ])
    assert.match(summary, /turning_point/)
    assert.match(summary, /s0006/)
    assert.equal(predictedHoleAText({ intent_v0: 'Fix add' }), 'Fix add')
    assert.match(predictedHoleAText({ intent_v0: 'Fix add', skeleton_summary: summary }), /Fix add/)
  })
})

describe('scoreHoleAVectorEfficiency', () => {
  it('skips quality when no gold intent / skeleton', async () => {
    const scored = await scoreHoleAVectorEfficiency({
      predicted_intent: 'Fix add',
      tokens: 100,
      segments_read: 4,
    })
    assert.equal(scored.quality, null)
    assert.equal(scored.cosine, null)
    assert.equal(scored.skeleton_recall, null)
    assert.equal(scored.efficiency, null)
    assert.equal(scored.tokens, 100)
    assert.equal(scored.cost, 100)
    assert.equal(scored.embedding, 'deterministic_hash')
  })

  it('gold intent cosine + more tokens same quality → lower efficiency', async () => {
    const embedder = new DeterministicHashEmbedding()
    const gold = 'Fix the failing test in add.ts so 1+1 equals 2.'
    const cheap = await scoreHoleAVectorEfficiency({
      predicted_intent: gold,
      gold_intent: gold,
      tokens: 20,
      segments_read: 2,
      embedder,
    })
    const dear = await scoreHoleAVectorEfficiency({
      predicted_intent: gold,
      gold_intent: gold,
      tokens: 2000,
      segments_read: 2,
      embedder,
    })
    assert.ok(cheap.cosine !== null && cheap.cosine > 0.99)
    assert.ok(cheap.quality !== null && cheap.quality > 0.99)
    assert.ok(cheap.efficiency !== null && dear.efficiency !== null)
    assert.ok(cheap.efficiency! > dear.efficiency!, `cheap=${cheap.efficiency} dear=${dear.efficiency}`)
  })

  it('optional skeleton recall mixes into quality when gold skeleton ids exist', async () => {
    const scored = await scoreHoleAVectorEfficiency({
      predicted_intent: 'same',
      gold_intent: 'same',
      predicted_skeleton_segment_ids: ['s1'],
      gold_skeleton_segment_ids: ['s1', 's2'],
      tokens: 10,
      segments_read: 1,
      embedder: new DeterministicHashEmbedding(),
    })
    assert.equal(scored.skeleton_recall, 0.5)
    assert.ok(scored.quality !== null)
    assert.ok(scored.cosine !== null)
    assert.equal(scored.quality, (cosineAsQuality(scored.cosine!) + 0.5) / 2)
  })
})

describe('resolveEmbeddingProvider', () => {
  it('defaults to deterministic hash without env / API keys', () => {
    const p = resolveEmbeddingProvider({})
    assert.equal(p.id, 'deterministic_hash')
    assert.ok(p instanceof DeterministicHashEmbedding)
  })

  it('openai without embedding API key throws (does not read mint key)', () => {
    assert.throws(
      () =>
        resolveEmbeddingProvider({
          TRACE_DISTILLER_EMBEDDING_PROVIDER: 'openai',
          TRACE_DISTILLER_API_KEY: 'mint-secret-must-not-be-reused',
        }),
      /TRACE_DISTILLER_EMBEDDING_API_KEY/,
    )
  })

  it('HttpEmbeddingProvider uses injected fetch and does not echo the key on HTTP error', async () => {
    const secret = 'sk-test-not-for-logs'
    const provider = new HttpEmbeddingProvider({
      url: 'https://example.invalid/v1/embeddings',
      api_key: secret,
      model: 'text-embedding-3-small',
      fetch: (async () =>
        new Response('nope', { status: 401, statusText: 'Unauthorized' })) as typeof fetch,
    })
    await assert.rejects(() => provider.embed('hello'), (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      assert.match(message, /embedding HTTP 401/)
      assert.doesNotMatch(message, /sk-test/)
      return true
    })
    const ok = new HttpEmbeddingProvider({
      url: 'https://example.invalid/v1/embeddings',
      api_key: secret,
      model: 'text-embedding-3-small',
      fetch: (async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    })
    assert.deepEqual([...(await ok.embed('hello'))], [1, 0, 0])
  })
})

describe('ADR-0011 (b) isolation', () => {
  it('sparse_intent / candidate_pool / cut_brain do not import vector_efficiency (not a stop signal)', () => {
    for (const name of ['sparse_intent.ts', 'candidate_pool.ts', 'cut_brain.ts', 'skeleton_pass.ts']) {
      const src = readFileSync(join(sessionsDir, name), 'utf8')
      assert.doesNotMatch(src, /vector_efficiency/)
    }
  })

  it('vector_efficiency does not import pi or pipeline', () => {
    const src = readFileSync(join(evalDir, 'vector_efficiency.ts'), 'utf8')
    assert.doesNotMatch(src, /@mariozechner\/pi/)
    assert.doesNotMatch(src, /createAgentSession/)
    assert.doesNotMatch(src, /from ['"].*pipeline/)
    assert.doesNotMatch(src, /from ['"].*sparse_intent/)
  })
})
