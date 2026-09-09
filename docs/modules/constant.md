# constant — 阈值与路由表

对应路径：`src/constant/`。压缩率目标、窗口大小、保守不裁阈值、skill 场景路由表。数字变更应改这里，不改 orchestrator 里的魔数。

---

## 1. 目的 / 非目标

**目的**

- 把「已经拍板的数字」和「有默认值但允许 CutProfile 覆盖的数字」集中存放。
- 洞 A 产出的 `scenario` → skill 文件名，必须是一张确定性表，由 orchestrator 查表，禁止 LLM 选 skill。

**非目标**

- 不是 CutProfile。CutProfile 是用户/运行时自定义面；constant 是仓库默认值。
- 不放环境相关配置（API key、模型名走环境变量 / service 入参）。
- 不放 SQLite 路径、报告 CSS。

---

## 2. 输入输出

无运行时 I/O。实现时按主题拆文件（如 `compression.ts` / `window.ts` / `skill_route.ts`）。

```ts
/** 压缩率：剪后 token / 原 token。PRD MVP 目标。 */
const COMPRESSION_RATIO_TARGET = { min: 0.10, max: 0.30 }

/** 洞 B 每窗段数。已拍板。 */
const LABEL_WINDOW_SIZE = 8

/** 卡片 head 原文首行截断。已拍板。 */
const SEGMENT_HEAD_MAX_CHARS = 120

/** 相邻 keep 允许跨过的最大段数。已拍板。 */
const SPAN_MAX_GAP_SEGMENTS = 3

/** 相似重试 token Jaccard。已拍板。 */
const SIMILAR_RETRY_TOKEN_JACCARD_THRESHOLD = 0.8

/** 解析失败 / 超 token → 该窗全部 keep（ADR-0008 Fail-Closed Keep） */
const FAIL_CLOSED_KEEP = true

/** 盲测 review 最多回填轮数（ADR-0009）。已拍板。 */
const REVIEW_MAX_ROUNDS = 2

/** pi 会话失败额外重试次数，仍失败则 Fail-Closed。已拍板。 */
const PI_FAILURE_RETRY = 1

/** 洞 A 头尾意图的预算提示：约 2k token，一次调用（ADR-0009） */
const SKELETON_PASS_TOKEN_HINT = 2000

/** 规则层清完后，预期仍要进洞 B 的段比例（成本粗账，不是硬门禁） */
const LLM_LABEL_FRACTION_HINT = 0.30

/** 场景 → skill 文件。键是已拍板 Scenario。查不到回退 implement。 */
const SKILL_ROUTE: Record<Scenario, string> = {
  debug: 'agent/skills/debug.md',
  implement: 'agent/skills/implement.md',
  refactor: 'agent/skills/refactor.md',
  test_fix: 'agent/skills/test_fix.md',
  investigate: 'agent/skills/investigate.md',
}

/** 默认 CutProfile id，CLI 不传 --profile 时用 */
const DEFAULT_PROFILE_ID = 'default'
```

CutProfile 的仓库默认值（与 [types.md](./types.md) 对齐）：

```ts
const DEFAULT_CUT_PROFILE = {
  id: 'default',
  keep_labels: ['key_decision', 'useful_exploration'],
  collapse_labels: ['dead_end'],
  drop_labels: ['routine'],
  compression_ratio: COMPRESSION_RATIO_TARGET,
  span: {
    max_gap_segments: SPAN_MAX_GAP_SEGMENTS, // 3
    fill_with_representative_dead_end: true,
  },
  dead_end: {
    max_representative: 3,
    summary_max_chars: 80,
  },
}
```

`resolveSkillRoute(scenario)`：五字面量命中则返回对应路径；其它值（含缺省）回退 `implement`，`fallback: true`。禁止静默空 prompt。

模型名**不进** constant。洞 A / 洞 B / L4 走环境变量 `TRACE_DISTILLER_MODEL_HOLE_A` / `TRACE_DISTILLER_MODEL_HOLE_B` / `TRACE_DISTILLER_MODEL_L4`（见 [pi-sdk.md](../guides/pi-sdk.md)）。

---

## 3. 职责与边界

**做**

- 默认阈值、路由表、窗口大小、review 轮数。
- 给报告首页的「目标区间」文案提供同一数字。

**禁止**

- 在 constant 里读 env、读文件、读 SQLite。
- 让洞 B 自己决定用哪份 skill——必须 orchestrator 查 `SKILL_ROUTE` 再传入 `labelWindow`。
- 把 benchmark 及格线（95% 召回等）偷偷改成流水线运行时门禁。那些是 [eval.md](./eval.md) / [benchmark/README.md](../../benchmark/README.md) 的事；constant 最多引用压缩率区间。

---

## 4. 依赖关系

```text
constant → enums（场景键）、types（CutProfile 形状，若用字面量满足结构）
        ← orchestrator / sessions / assembler / eval / service 读取
```

constant **不依赖** pipeline 实现、不依赖 pi、不依赖 data。

---

## 5. 关键规则 / 算法

- **规则优先、LLM 少看**（[ADR-0002](../adr/0002-rule-first-labeling.md)）：`LLM_LABEL_FRACTION_HINT` 是成本叙事用的粗账（0009 写约 1/5 token、规则清完剩约 30%），不是「超过 30% 就失败」的断言。真值以 SQLite 统计为准。
- **保守不裁**（ADR-0008）：`FAIL_CLOSED_KEEP = true` 在 MVP 不允许改成「失败当死胡同删掉」。
- **乘法复合分的压缩率映射**（[ADR-0005](../adr/0005-benchmark-multiplicative-score.md)）属于 eval/benchmark，不进流水线 constant。流水线只认 10%–30% 目标区间。
- **skill 热更新活口**：路由表指向 Markdown 路径；后期加 `rewrite_skill` 不必改目录结构（architecture「三条活口」）。

---

## 6. 仍开放的设计问题

上列数字与 Scenario 路由已拍板。仍开放：

1. **tokenizer / 是否对齐 provider**：压缩率口径是 RawTrace 原文 token，计数库选型未锁。
2. **CutProfile 运行时文件格式**：JSON 还是 TS 模块（service 开放问题）。

---

## 7. 实现完成标准

- [x] orchestrator / assembler / eval 中无散落魔数（测试夹具除外）；默认值在本目录。
- [x] `SKILL_ROUTE` 查不到场景码回退 `implement`，有单测；禁止静默空 prompt。
- [x] `FAIL_CLOSED_KEEP` 为 true；若有人改 false，必须先改 ADR。
- [x] 默认 CutProfile 与 PRD 的保留策略一致：关键决策 + 有效探索保留，死胡同压缩，例行删除。
- [x] 窗口 / span / Jaccard / head / 死胡同数字已写入本文件，不再标 OPEN。
