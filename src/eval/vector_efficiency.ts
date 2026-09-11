/**
 * ADR-0011 (b) Hole A vector efficiency — **benchmark / report only**.
 * Never an online stop signal. sparse_intent still stops on `enough` + hard budget.
 */
import { createHash } from 'node:crypto'
import { keyStepRecall } from './metrics.ts'

export const DETERMINISTIC_EMBED_DIM = 32
export const DETERMINISTIC_EMBEDDING_ID = 'deterministic_hash' as const
export const EMBEDDING_PROVIDER_ENV = 'TRACE_DISTILLER_EMBEDDING_PROVIDER'
export const EMBEDDING_URL_ENV = 'TRACE_DISTILLER_EMBEDDING_URL'
export const EMBEDDING_API_KEY_ENV = 'TRACE_DISTILLER_EMBEDDING_API_KEY'
export const EMBEDDING_MODEL_ENV = 'TRACE_DISTILLER_EMBEDDING_MODEL'

/** Pluggable embedding. Default CI path is DeterministicHashEmbedding (no network). */
export interface EmbeddingProvider {
  readonly id: string
  embed(text: string): Promise<readonly number[]>
}

export interface HoleAVectorScore {
  quality: number | null
  cosine: number | null
  skeleton_recall: number | null
  tokens: number
  segments_read: number
  /** tokens if >0, else segments_read (FakeSessionBackend may report 0 usage). */
  cost: number
  /** quality / log(1 + cost). null when quality is skipped (no gold). */
  efficiency: number | null
  embedding: string
}

export interface HoleAVectorInput {
  predicted_intent: string
  predicted_skeleton_summary?: string
  predicted_skeleton_segment_ids?: readonly string[]
  /** Gold intent text. Missing / empty → cosine skipped. */
  gold_intent?: string | null
  /** Explicit gold skeleton point ids. Missing → recall skipped (do not reuse key-decision ids). */
  gold_skeleton_segment_ids?: readonly string[] | null
  tokens: number
  segments_read: number
  embedder?: EmbeddingProvider
}

/**
 * Cosine similarity. Zero vector → 0 (no NaN). Orthogonal → 0. Identical → 1.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Map cosine [-1, 1] onto quality [0, 1]. */
export function cosineAsQuality(cosine: number): number {
  if (!Number.isFinite(cosine)) return 0
  return clamp01(cosine)
}

/**
 * Composite: quality / log(1 + cost). Same quality, more tokens → lower score (whack-a-mole).
 * cost <= 0 → return quality (zero-cost run is not penalized; avoids log1p(0)=0).
 */
export function vectorEfficiencyComposite(quality: number, cost: number): number {
  const q = clamp01(quality)
  const c = Math.max(0, cost)
  const denom = Math.log1p(c)
  if (denom === 0) return q
  return q / denom
}

export function skeletonPointRecall(input: {
  gold_segment_ids: readonly string[]
  predicted_segment_ids: readonly string[]
}): number {
  return keyStepRecall({
    gold_segment_ids: input.gold_segment_ids,
    kept: input.predicted_segment_ids,
  })
}

export function summarizeSkeletonPoints(
  nodes: readonly { kind: string; note: string; segment_ids: readonly string[] }[],
): string {
  return nodes.map((n) => `${n.kind} ${n.note} ${n.segment_ids.join(' ')}`.trim()).join('\n')
}

export function predictedHoleAText(input: {
  intent_v0: string
  skeleton_summary?: string
}): string {
  const intent = input.intent_v0.trim()
  const summary = input.skeleton_summary?.trim() ?? ''
  if (summary.length === 0) return intent
  if (intent.length === 0) return summary
  return `${intent}\n${summary}`
}

export function holeAQuality(input: {
  cosine: number | null
  skeleton_recall: number | null
}): number | null {
  const parts: number[] = []
  if (input.cosine !== null) parts.push(cosineAsQuality(input.cosine))
  if (input.skeleton_recall !== null) parts.push(clamp01(input.skeleton_recall))
  if (parts.length === 0) return null
  return parts.reduce((sum, n) => sum + n, 0) / parts.length
}

export function efficiencyCost(tokens: number, segments_read: number): number {
  const t = Number.isFinite(tokens) ? Math.max(0, tokens) : 0
  const s = Number.isFinite(segments_read) ? Math.max(0, segments_read) : 0
  return t > 0 ? t : s
}

/** Bag-of-tokens SHA-256 embedding. Same text → same vector. No network. */
export class DeterministicHashEmbedding implements EmbeddingProvider {
  readonly id = DETERMINISTIC_EMBEDDING_ID
  private readonly dim: number
  constructor(dim: number = DETERMINISTIC_EMBED_DIM) {
    this.dim = dim
  }

  async embed(text: string): Promise<readonly number[]> {
    const dim = this.dim
    const vec = new Array<number>(dim).fill(0)
    const tokens = tokenize(text)
    if (tokens.length === 0) {
      vec[0] = 1
      return vec
    }
    for (const tok of tokens) {
      const digest = createHash('sha256').update(tok).digest()
      for (let i = 0; i < dim; i += 1) {
        const b = digest[i % digest.length]!
        const cur = vec[i] ?? 0
        vec[i] = cur + (b / 255) * 2 - 1
      }
    }
    return l2normalize(vec)
  }
}

export interface HttpEmbeddingConfig {
  url: string
  api_key: string
  model: string
  fetch?: typeof fetch
}

/** Optional OpenAI-compatible embeddings HTTP. Bench only; never used by sparse_intent. */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly id: string
  private readonly cfg: HttpEmbeddingConfig
  constructor(cfg: HttpEmbeddingConfig, id = 'http') {
    this.cfg = cfg
    this.id = id
  }

  async embed(text: string): Promise<readonly number[]> {
    const fetchFn = this.cfg.fetch ?? fetch
    const res = await fetchFn(this.cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.api_key}`,
      },
      body: JSON.stringify({ model: this.cfg.model, input: text }),
    })
    if (!res.ok) {
      throw new Error(`embedding HTTP ${String(res.status)}`)
    }
    const parsed: unknown = await res.json()
    const vec = readEmbedding(parsed)
    if (vec === null) throw new Error('embedding HTTP: missing data[0].embedding')
    return vec
  }
}

/**
 * Default = deterministic hash (CI / --fake-l4, no API key).
 * Real path: TRACE_DISTILLER_EMBEDDING_PROVIDER=openai|http plus URL + EMBEDDING_API_KEY.
 * Does not reuse TRACE_DISTILLER_API_KEY (mint key is a different gateway).
 */
export function resolveEmbeddingProvider(
  env: NodeJS.Dict<string> = process.env,
): EmbeddingProvider {
  const raw = (env[EMBEDDING_PROVIDER_ENV] ?? DETERMINISTIC_EMBEDDING_ID).trim()
  const id = raw.length === 0 ? DETERMINISTIC_EMBEDDING_ID : raw
  if (id === DETERMINISTIC_EMBEDDING_ID || id === 'fake') {
    return new DeterministicHashEmbedding()
  }
  if (id === 'openai' || id === 'http') {
    const key = env[EMBEDDING_API_KEY_ENV]
    if (key === undefined || key.length === 0) {
      throw new Error(
        `${EMBEDDING_API_KEY_ENV} is required when ${EMBEDDING_PROVIDER_ENV}=${id} (do not reuse mint TRACE_DISTILLER_API_KEY)`,
      )
    }
    const url =
      (env[EMBEDDING_URL_ENV] ?? '').trim() ||
      (id === 'openai' ? 'https://api.openai.com/v1/embeddings' : '')
    if (url.length === 0) {
      throw new Error(`${EMBEDDING_URL_ENV} is required when ${EMBEDDING_PROVIDER_ENV}=http`)
    }
    const model = (env[EMBEDDING_MODEL_ENV] ?? 'text-embedding-3-small').trim()
    return new HttpEmbeddingProvider({ url, api_key: key, model }, id)
  }
  throw new Error(`unknown ${EMBEDDING_PROVIDER_ENV}=${id}`)
}

export async function scoreHoleAVectorEfficiency(
  input: HoleAVectorInput,
): Promise<HoleAVectorScore> {
  const embedder = input.embedder ?? new DeterministicHashEmbedding()
  const tokens = Number.isFinite(input.tokens) ? Math.max(0, input.tokens) : 0
  const segments_read = Number.isFinite(input.segments_read)
    ? Math.max(0, input.segments_read)
    : 0
  const cost = efficiencyCost(tokens, segments_read)

  const goldIntent = input.gold_intent?.trim() ?? ''
  let cosine: number | null = null
  if (goldIntent.length > 0) {
    const predicted = predictedHoleAText({
      intent_v0: input.predicted_intent,
      ...(input.predicted_skeleton_summary !== undefined
        ? { skeleton_summary: input.predicted_skeleton_summary }
        : {}),
    })
    const gold = predictedHoleAText({ intent_v0: goldIntent })
    const [pv, gv] = await Promise.all([embedder.embed(predicted), embedder.embed(gold)])
    cosine = cosineSimilarity(pv, gv)
  }

  let skeleton_recall: number | null = null
  const goldSkel = input.gold_skeleton_segment_ids
  if (goldSkel !== undefined && goldSkel !== null) {
    skeleton_recall = skeletonPointRecall({
      gold_segment_ids: goldSkel,
      predicted_segment_ids: input.predicted_skeleton_segment_ids ?? [],
    })
  }

  const quality = holeAQuality({ cosine, skeleton_recall })
  const efficiency = quality === null ? null : vectorEfficiencyComposite(quality, cost)
  return {
    quality,
    cosine,
    skeleton_recall,
    tokens,
    segments_read,
    cost,
    efficiency,
    embedding: embedder.id,
  }
}

function tokenize(text: string): string[] {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (norm.length === 0) return []
  const words = norm.split(/[^a-z0-9]+/u).filter((t) => t.length > 0)
  return [norm, ...words]
}

function l2normalize(vec: number[]): number[] {
  let n = 0
  for (const x of vec) n += x * x
  if (n === 0) {
    const out = vec.slice()
    if (out.length === 0) return [1]
    out[0] = 1
    return out
  }
  const s = Math.sqrt(n)
  return vec.map((x) => x / s)
}

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function readEmbedding(value: unknown): number[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const data = (value as { data?: unknown }).data
  if (!Array.isArray(data) || data[0] === undefined) return null
  const row = data[0]
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null
  const embedding = (row as { embedding?: unknown }).embedding
  if (!Array.isArray(embedding) || embedding.some((n) => typeof n !== 'number')) return null
  return embedding as number[]
}
