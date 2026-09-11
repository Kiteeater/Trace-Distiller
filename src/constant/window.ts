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

/** 洞 A 头尾意图的预算提示：约 2k token，一次调用（ADR-0009）。 */
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
 * cut-brain ReAct 最大轮数（ADR-0010）：propose → tool → mask → iterate。
 * 禁止在 sessions 另写魔数。
 */
export const CUT_BRAIN_MAX_ROUNDS = 4
