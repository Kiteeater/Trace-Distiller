/**
 * OPEN: 洞 B 每窗段数未拍板。docs/modules/constant.md §6。
 * 命名占位，禁止在 orchestrator 另写魔数；未拍板前不得当实现阈值。
 */
export const LABEL_WINDOW_SIZE = undefined as unknown as number

/**
 * OPEN: 相邻 keep 允许跨过的最大段数未拍板。docs/modules/constant.md §6、ADR-0004。
 */
export const SPAN_MAX_GAP_SEGMENTS = undefined as unknown as number

/**
 * OPEN: 相似重试 token Jaccard 阈值未拍板。docs/modules/constant.md §6。
 */
export const SIMILAR_RETRY_TOKEN_JACCARD_THRESHOLD = undefined as unknown as number

/** 解析失败 / 超 token → 该窗全部 keep（ADR-0008）。MVP 不允许改成失败当死胡同。 */
export const FAIL_CLOSED_KEEP = true

/** 盲测 review 最多回填轮数（ADR-0009）。 */
export const REVIEW_MAX_ROUNDS = 2

/** 洞 A 头尾意图的预算提示：约 2k token，一次调用（ADR-0009）。 */
export const SKELETON_PASS_TOKEN_HINT = 2000
