# constant — 阈值与路由表

对应路径：`src/constant/`。压缩率目标、窗口大小、保守不裁阈值、skill 场景路由表。数字变更应改这里，不改 orchestrator 里的魔数。

---

## 1. 目的 / 非目标

**目的**

- 把「已经拍板的数字」和「有默认值但允许 CutProfile 覆盖的数字」集中存放。
- 洞 A 产出的 `scenario` → skill 文件名，必须是一张确定性表，由 orchestrator 查表，禁止 LLM 选 skill。

**非目标**

- 不是 CutProfile。CutProfile 是用户/运行时自定义面；constant 是仓库默认值。
- 不放环境相关配置（API key、模型名走环境变量 / service 入参，见开放问题）。
- 不放 SQLite 路径、报告 CSS。

---

## 2. 输入输出

无运行时 I/O。实现时按主题拆文件（如 `compression.ts` / `window.ts` / `skill_route.ts`）。

```ts
/** 压缩率：剪后 token / 原 token。PRD MVP 目标。 */
const COMPRESSION_RATIO_TARGET = { min: 0.10, max: 0.30 }

/** 洞 B 每窗段数。具体数字未拍板，落地前必须定。 */
const LABEL_WINDOW_SIZE: number  // OPEN

/** 解析失败 / 超 token → 该窗全部 keep（ADR-0008 Fail-Closed Keep） */
const FAIL_CLOSED_KEEP = true

/** 盲测 review 最多回填轮数（ADR-0009） */
const REVIEW_MAX_ROUNDS = 2

/** 洞 A 头尾意图的预算提示：约 2k token，一次调用（ADR-0009） */
const SKELETON_PASS_TOKEN_HINT = 2000

/** 规则层清完后，预期仍要进洞 B 的段比例（成本粗账，不是硬门禁） */
const LLM_LABEL_FRACTION_HINT = 0.30

/** 场景 → skill 文件。键必须是 scenario enum。名单未拍板。 */
const SKILL_ROUTE: Record<string, string> = {
  // 例（占位，不是已批准场景）：
  // debug: 'skills/debug.md',
}

/** 默认 CutProfile id，CLI 不传 --profile 时用 */
const DEFAULT_PROFILE_ID = 'default'
```

CutProfile 的仓库默认值（与 [types.md](./types.md) 对齐，数字未全部拍板的标 OPEN）：

```ts
const DEFAULT_CUT_PROFILE = {
  id: 'default',
  keep_labels: ['key_decision', 'useful_exploration'],
  collapse_labels: ['dead_end'],
  drop_labels: ['routine'],
  compression_ratio: COMPRESSION_RATIO_TARGET,
  span: {
    max_gap_segments: /* OPEN */,
    fill_with_representative_dead_end: true,
  },
  dead_end: {
    max_representative: /* OPEN */,
    summary_max_chars: /* OPEN */,
  },
}
```

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

1. **`LABEL_WINDOW_SIZE`**：现有文档没给数字。太大浪费 context，太小骨架注入占比过高。
2. **span `max_gap_segments`**：ADR-0004 只说「够得着」，没有可执行阈值。是段数、token 数，还是要靠洞 B `check_continuity` 分数？三者如何分工未写死。
3. **死胡同 `max_representative`**：PRD 说「少量」，没有 N。
4. **模型档位常量要不要进 constant**：architecture 说骨架可用更强档、QA 可降档。模型名是部署配置还是仓库常量？
5. **场景路由表的键**：取决于 scenario 名单（见 [enums.md](./enums.md)）。
6. **Jaccard 相似重试阈值**：TODO 要求 token Jaccard 聚类，阈值未给。

---

## 7. 实现完成标准

- [ ] orchestrator / assembler / eval 中无散落魔数（测试夹具除外）。
- [ ] `SKILL_ROUTE` 查不到场景码 = 硬失败或回退到默认 skill，行为有单测；禁止静默空 prompt。
- [ ] `FAIL_CLOSED_KEEP` 为 true；若有人改 false，必须先改 ADR。
- [ ] 默认 CutProfile 与 PRD 的保留策略一致：关键决策 + 有效探索保留，死胡同压缩，例行删除。
- [ ] 开放数字在代码落地前补进本文件或另开 ADR，不在 PR 里随手填。
