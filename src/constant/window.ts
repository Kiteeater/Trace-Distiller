/**
 * 洞 B 每窗段数。已拍板：8。
 * 禁止在 orchestrator 另写魔数。
 */
export const LABEL_WINDOW_SIZE = 8

/**
 * 卡片 head 原文首行截断字符数。已拍板：120。
 * segmenter 必须遵守，禁止 LLM 生成 head。
 */
export const SEGMENT_HEAD_MAX_CHARS = 120

/**
 * 洞 A/B 注入 CARD_INDEX / WINDOW_CARDS 时的 head 截断。严于 SEGMENT_HEAD_MAX_CHARS。
 * 卡片库仍存 120；prompt 只给短 head，全文走 read_segment。
 */
export const CARD_INDEX_HEAD_MAX_CHARS = 40

/**
 * 洞 A HEAD/VERIFICATION 每条 turn 正文上限。
 * 长 tool_result 截断，避免与卡片索引重复灌原文。
 */
export const SKELETON_TURN_CONTENT_MAX_CHARS = 200

/**
 * 单段 CARD_INDEX JSON 粗上限（测试守卫）。id+tool+sig+outcome+短 head 应远小于此。
 */
export const CARD_INDEX_CHARS_PER_SEGMENT_MAX = 220

/**
 * 相邻 keep 允许跨过的最大段数。已拍板：3（ADR-0004）。
 * 允许丢掉少量例行段，长跳仍判违规。collapse 占位算一步。
 * 禁止在 pipeline 里另写魔数。
 */
export const SPAN_MAX_GAP_SEGMENTS = 3

/**
 * 相似重试 token Jaccard 阈值。已拍板：0.8。
 * 只把高重叠文本聚成重试，避免把有效探索并进死胡同。
 */
export const SIMILAR_RETRY_TOKEN_JACCARD_THRESHOLD = 0.8

/** 解析失败 / 超 token → 该窗全部 keep（ADR-0008）。MVP 不允许改成失败当死胡同。 */
export const FAIL_CLOSED_KEEP = true

/** 盲测 review 最多回填轮数（ADR-0009）。已拍板：2。 */
export const REVIEW_MAX_ROUNDS = 2

/** 洞 A 单轮提示预算提示（兼容旧测试）；多轮硬预算见 SPARSE_INTENT_*（ADR-0011）。 */
export const SKELETON_PASS_TOKEN_HINT = 2000

/** pi 会话失败后额外重试次数；仍失败则 Fail-Closed Keep。已拍板：1。 */
export const PI_FAILURE_RETRY = 1

/**
 * 单次 pi 会话调用（prompt/attach）硬超时毫秒数。
 * bench / distill 有 mint env 时禁止无限挂起；可用 TRACE_DISTILLER_SESSION_TIMEOUT_MS 覆盖。
 */
export const SESSION_CALL_TIMEOUT_MS = 120_000

/** 覆盖 SESSION_CALL_TIMEOUT_MS 的 env 名。 */
export const SESSION_TIMEOUT_ENV = 'TRACE_DISTILLER_SESSION_TIMEOUT_MS'

/**
 * cut-brain 绝对轮数安全帽（ADR-0012）。
 * 运营预算是 unresolved × CUT_BRAIN_ROUNDS_PER_UNRESOLVED；禁止在 sessions 另写魔数。
 */
export const CUT_BRAIN_MAX_ROUNDS = 256

/** 轮数 ≤ 未决 × 此值（ADR-0012）。 */
export const CUT_BRAIN_ROUNDS_PER_UNRESOLVED = 2

/** 每段最多披露证据卡次数（ADR-0012）。 */
export const CUT_BRAIN_PER_SEGMENT_DISCLOSE_CAP = 2

/** v1 单槽：focus 恒为 1（ADR-0012）。禁止 focus=2。 */
export const CUT_BRAIN_FOCUS_SLOT = 1

/**
 * S2 证据卡硬 token 帽（ADR-0012）。
 * Fake 与真路径必须 import 同一常量、同一数值。
 */
export const S2_EVIDENCE_CARD_TOKEN_CAP = 256

/** confidence < 此值 → 低置信，不得落到 keep（ADR-0012）。 */
export const CUT_BRAIN_LOW_CONFIDENCE = 0.5

/** schema 非法时每段额外重试次数；耗尽 → collapse_uncertain（不是 0010 Keep）。 */
export const CUT_BRAIN_SCHEMA_RETRIES = 1

/** Write 超阈：tokens ≥ max(median × 此倍数, WRITE_OUTLIER_TOKEN_FLOOR)。 */
export const WRITE_OUTLIER_TOKEN_MULTIPLIER = 2

/** Write 超阈 token 下限，避免短样 median=0 时永不触发。 */
export const WRITE_OUTLIER_TOKEN_FLOOR = 64

/** keep 正向证据闭集（ADR-0012）。禁止实现侧私加。 */
export const KEEP_EVIDENCE_BITS = ['skeleton_hit', 'key_decision_flag'] as const

export type KeepEvidenceBit = (typeof KEEP_EVIDENCE_BITS)[number]

/** S2 证据卡种类闭集（ADR-0012）。 */
export const EVIDENCE_CARD_KINDS = ['structure', 'headtail', 'error'] as const

export type EvidenceCardKind = (typeof EVIDENCE_CARD_KINDS)[number]

/**
 * 洞 A 多轮稀疏采样硬预算（ADR-0011）。
 * 禁止在 sessions 另写魔数。在线停机只认 enough + 这些上限。
 */
export const SPARSE_INTENT_MAX_ROUNDS = 3

/** 洞 A 最多经 read_segment 读入的 segment 数。 */
export const SPARSE_INTENT_MAX_SEGMENTS_READ = 12

/** 洞 A 会话累计 token 硬上限（input+output；estimateTokens / 真用量累加）。 */
export const SPARSE_INTENT_MAX_TOKENS = 8_000

/** 每轮从候选池抽取的 segment 数（未读优先；gaps 加权）。 */
export const SPARSE_INTENT_ROUND_SAMPLE_SIZE = 4

/** 头段锚点：前 N 个 segment（再与 head_turn_ids 映射并集）。 */
export const SPARSE_INTENT_HEAD_SEGMENTS = 2

/** 工具失败密集窗：滑动窗口长度。 */
export const SPARSE_INTENT_FAILURE_WINDOW = 4

/** 窗内 error 段数 ≥ 此值则标为 tool_failure_dense。 */
export const SPARSE_INTENT_FAILURE_DENSE_MIN = 2

/** 强制停机时的 uncertainty 下限（agent 自报更低也抬到此值）。 */
export const SPARSE_INTENT_FORCE_STOP_UNCERTAINTY = 0.85
