# report — 自包含 HTML 报告

对应路径：`src/report/`。纯函数：结果 JSON → html 字符串。这是 Playback Cut 的实例化，也是 demo 的核心镜头（「500 步的墙 → 30 步的精华」）。

**不做 GUI，不做本地 web server。** 组会投屏双击打开；发文件即演示。

---

## 1. 目的 / 非目标

**目的**

- 导出单个 `.html`：内嵌结果 JSON + vanilla JS，零依赖、零服务器。
- 可解释裁剪：每个被删/压缩段落可点开，看到删除理由 + 打标来源（规则名 / 洞 B 标签 + 置信度）。这是信任来源。
- 成本可视化放首页：规则层处理了多少段、LLM 只看了百分之几——第二个卖点。

**非目标**

- Electron / Tauri / Next.js / 本地 `localhost`。
- 在线服务、账号、分享链接。
- Training Cut 的 UI（训练版继续是 JSONL）。
- 在报告里重新跑流水线或改 CutProfile（那是 CLI）。报告只读。
- 评测公式实现（读 eval/data 已经算好的数字）。

---

## 2. 输入输出

```ts
interface ReportModel {
  meta: TraceMeta
  intent: IntentHypothesis
  original_step_count: number
  kept_step_count: number
  playback: PlaybackCut
  warrant: CutWarrant
  labels: LabelDecision[]
  coverage: { total: number; ruled: number; llm: number; fail_closed: number }
  metrics: {
    compression_ratio: number
    distill_cost_ratio: number
    llm_segment_fraction: number
  }
  /** 可选：全量 LLM 对照组，TODO 成本基线 */
  baseline?: { distill_cost_ratio: number }
}

/** 纯函数。禁止读盘、禁止写盘、禁止 fetch */
function renderHtml(model: ReportModel): string
```

写盘由 [service.md](./service.md) 做（`report.ts` 薄壳）。

页面结构（与 TODO 讲解视频 5 步叙事对齐，便于边做边录）：

1. **首页镜头**：左原始步数墙 / 右精华步数；压缩率；成本（规则 vs LLM）。
2. **双栏回放**：左可折叠的原始卡片索引，右 Playback 序列。
3. **点开删除**：drop/collapse 的 warrant.source + confidence + 死胡同摘要。
4. **盲测结论区**：通过/未通过、回填轮数（有则显示）。
5. **收尾两个数字**：压缩率 + 处理成本比。

---

## 3. 职责与边界

**做**

- 把 `ReportModel` 变成一个能 `file://` 打开的 HTML 字符串。
- 内嵌 CSS/JS，不外链 CDN（演示场合常没网或投屏限制）。
- 对 collapse 显示那一句摘要；对 keep 显示卡片 head/sig。

**禁止**

- `fetch`、WebSocket、动态 `import()` 远程脚本。
- 在 renderer 里调 sqlite / pi / distill。
- 为版面好看改因果顺序或再摘要 keep 段。
- 把 Training 原文默认铺满页面（太长，墙在左边用索引即可；需要原文走 raw_refs 展开——展开的数据必须已内嵌 JSON，不能现去读仓库文件，否则发给别人的 html 是空的）。

---

## 4. 依赖关系

```text
report → types, enums（展示用对照表）
      ← service/report.ts
      ✗ pipeline / agent / data / pi / fs
```

「零 IO」是本模块的测试切面：给定 fixture JSON，渲染结果含关键数字字符串。

若觉得从 data 读更方便，**必须在 service 层**组装 `ReportModel`，不要让 `renderHtml` 打开数据库。

---

## 5. 关键规则 / 算法

- 展示层 = 自包含 HTML（architecture v0.3）。
- 可解释性来自 CutWarrant，不是事后让模型写「为什么删」。
- 成本数字与 data/eval 同源，禁止在 HTML 里四舍五入成另一套口径还不注明。
- 讲解视频剧本（TODO）：500 步的墙 → 规则先干粗活 → 可解释删除 → 盲测 → 两个数字收尾。报告信息架构按这个走，避免做成普通 dashboard。

---

## 6. 仍开放的设计问题

1. **视觉与交互细节**：现有文档只规定镜头和必须有的信息，没有线框。本模块不把配色当契约。
2. **超长 trace 内嵌 JSON 的体积**：500 段 full 原文会让 html 巨大。建议内嵌卡片 + drop 理由 + keep 的 head；full 原文仅 keep 段按需内嵌。未拍板。
3. **中文 UI 文案**是否固定。
4. M1「中段就要有报告骨架」：允许 metrics 空缺时显示「未跑 eval」，不要阻塞渲染。

---

## 7. 实现完成标准

- [ ] `renderHtml` 无 IO；单测：fixture → 字符串含压缩率、含一条 drop 理由。
- [ ] 产出文件离线可打开（测试可用正则或轻量 DOM，不必上浏览器自动化；若仓库之后有浏览器工具再补）。
- [ ] 无外链脚本。
- [ ] 不出现「请先启动 server」类文案。
- [ ] 左原始 / 右精华 / 点开删除 / 首页成本，四块都有对应 DOM 钩子（id/class），方便录屏指认。
