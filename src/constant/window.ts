/**
 * OPEN: 洞 B 每窗段数未拍板。docs/modules/constant.md §6。
 * 命名占位，禁止在 orchestrator 另写魔数；未拍板前不得当实现阈值。
 */
export const LABEL_WINDOW_SIZE = undefined as unknown as number

/**
 * OPEN: 卡片 head 原文首行截断字符数未拍板。docs/modules/pipeline-segmenter.md。
 * 命名占位；未拍板前不得当实现阈值。
 */
export const SEGMENT_HEAD_MAX_CHARS = undefined as unknown as number

/**
 * OPEN: 相邻 keep 允许跨过的最大段数未拍板。docs/modules/constant.md §6、ADR-0004。
 * 未拍板前的保守默认 3：允许相邻保留步之间丢掉少量例行段，长跳仍判违规，
 * 避免剪过头却声称够得着。collapse 占位算一步。禁止在 pipeline 里另写魔数。
 */
export const SPAN_MAX_GAP_SEGMENTS = 3

/**
 * OPEN: 相似重试 token Jaccard 阈值未拍板。docs/modules/constant.md §6、pipeline-rules.md §6。
 * 未拍板前的保守默认 0.8：只把高重叠文本聚成重试，避免把有效探索并进死胡同。
 * 禁止在 pipeline 里另写魔数；改阈值只改这一处。
 */
export const SIMILAR_RETRY_TOKEN_JACCARD_THRESHOLD = 0.8

/** 解析失败 / 超 token → 该窗全部 keep（ADR-0008）。MVP 不允许改成失败当死胡同。 */
export const FAIL_CLOSED_KEEP = true

/** 盲测 review 最多回填轮数（ADR-0009）。 */
export const REVIEW_MAX_ROUNDS = 2

/** 洞 A 头尾意图的预算提示：约 2k token，一次调用（ADR-0009）。 */
export const SKELETON_PASS_TOKEN_HINT = 2000
