# Guides 索引

> **主基调在 [PRD.md](../../PRD.md)、[architecture.md](../architecture.md)、[docs/adr/](../adr/)。本目录只展开，不另起炉灶。**

工程契约（字段、模块边界、完成标准）在 [docs/modules/](../modules/)。guides 讲「怎么理解、怎么用、边界在哪」；不要把这里写成第二份 types 说明书。

## 目的

给后来的人一条阅读路径：产品直觉 → 原料怎么进 → 流水线怎么剪 → 怎么证明剪好了。把三路并行写下的操作说明收成一张目录。

## 读者

先看过仓库根 [README.md](../../README.md) 的人。实现前读 guides 建立操作图；动工某一层时再打开对应 `docs/modules/*.md`。

## 已定结论（读 guides 之前先钉死）

这些已经拍板，guides **禁止推翻**：

- **流水线 + 两个 agent 洞**，不是单一 Distiller Agent（[ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)）
- 编排纯 TypeScript，无 LangChain；LLM 只在洞 A / 洞 B
- 洞 A = 头尾意图 + 验证点锚点 + 增量骨架，不是全量读（[ADR-0009](../adr/0009-agent-view-and-cut-warrant.md)）
- 规则优先；Admission Gate；Training / Playback 双产物同源 CutPlan
- 产品形态：CLI + CutProfile；训练侧主入口 CLI（Training Cut / JSONL）；复盘侧 CLI + 只读即时页，另有事后自包含 HTML Playback
- **live = 同步 Distiller 自己的裁剪过程与结果**，不是盯 Claude Code / 其它 coding agent 的运行进度
- 失败 Trace 不分析；只读 live 绝不干预；蒸馏主链路仍离线

## 全部 guides

| 文档 | 一句话 | 从哪路来 |
|------|--------|----------|
| [users-and-surfaces.md](./users-and-surfaces.md) | 两类读者；训练 CLI；复盘 CLI + 只读 live（盯 Distiller 裁剪，不是对方 agent）+ 事后 HTML | 用户面 |
| [tools.md](./tools.md) | 洞内工具草案（稍后拍板）+ Live 复盘工具闭集（已拍） | 用户面 |
| [ingest-and-preprocess.md](./ingest-and-preprocess.md) | 过门之后：切段 → 规则 → 未决才进洞；GT / 锚点 / sig / token / 切段默认已收 | 用户面 |
| [agent-gateway.md](./agent-gateway.md) | 「Agent Gateway」= 离线 Trace 接入门面，不是在线网关，也不是 live 页 | 评测 / 接入 |
| [datasets.md](./datasets.md) | 原料从哪来、GT 门槛、M1 的 3–5 条、怎么双标 | 评测 / 接入 |
| [file-architecture.md](./file-architecture.md) | architecture v0.3 目录树确认书：已定 vs OPEN | 架构 / harness |
| [agent-harness.md](./agent-harness.md) | 两个洞的 harness，不是 Distiller Runtime Agent | 架构 / harness |
| [pi-sdk.md](./pi-sdk.md) | 薄包 pi：洞里用什么、Distiller 自己干什么、换内核活口 | 架构 / harness |
| [benchmark.md](./benchmark.md) | 6 指标、乘法复合分、分档赛道；MVP 只强制压缩+保真 | 评测 / 接入 |

本文件是索引。

## 阅读顺序

不必一次读完。按你要干什么选：

```text
1. 仓库 README → PRD → 本索引
2. users-and-surfaces          你是谁、点什么
3. agent-gateway → datasets    什么东西能进门、放哪
4. ingest-and-preprocess       进门后规则先干活
5. file-architecture           代码落在哪几个目录
6. agent-harness → tools → pi-sdk
                               洞 A / 洞 B 怎么嵌、工具为什么只有这些
7. benchmark                   怎么打分、MVP 测哪两项
```

主基调文件穿插着读，不必等 guides：

- 决策：[adr/README.md](../adr/README.md)（尤其 0008 / 0009）
- 分期：[milestones.md](../milestones.md) / [TODO.md](../TODO.md)
- 动工契约：[modules/README.md](../modules/README.md)

## 怎么用 / 怎么跑

guides 不是可执行手册的替代——CLI 还没建。跑通一条成功 Trace 的预期路径在 [users-and-surfaces.md](./users-and-surfaces.md) 和 [script-run-distill.md](../modules/script-run-distill.md)：

```text
node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--report out.html]
```

无 Ground Truth → 拒之门外。事后展示层仍是自包含 `.html`；复盘跑着时可挂只读 live 页（同步 Distiller 裁剪进度，不是对方 agent）。

## 你还没点名但该有

下面几件事没有单独成篇（避免和 ADR / modules 打重复），但读 guides 时必须知道落在哪。

### CutProfile 自定义面

「每个人想要的剪法不一样」不是 GUI 需求，是三个参数：标签保留策略、压缩率区间、span 约束。收进声明式 **CutProfile**，CLI 吃 profile 跑（ADR-0009）。

自定义面一共三块：

1. **CutProfile** — 这次怎么剪
2. **skill 文件** — 分场景先验（洞 B）
3. **adapter** — 新的 Trace 格式（Gateway）

对话调优若做（M3 之后）：agent 只能改 profile，然后流水线重跑。默认值在 [constant.md](../modules/constant.md)，字段草图在 [types.md](../modules/types.md)。数字（`max_gap_segments` 等）仍有 OPEN。

### 成本卖点

工具自己不能是成本黑洞（PRD 的坑；[ADR-0002](../adr/0002-rule-first-labeling.md) 规则优先）。报告首页要同时出现：

- 压缩率（500 步的墙 → 约 30 步）
- 处理成本比 +「LLM 只看了百分之几」

粗账：全量打标 ~150k+ token；本方案约 **1/5**。数字从 SQLite 聚合，由 eval 写入、report 展示，禁止口头估。L4（QA / 重放 / review）token **不算**进蒸馏成本（[ADR-0007](../adr/0007-separate-brain-label-judge-budgets.md)）。详见 [benchmark.md](./benchmark.md)。

### 明确不做

写在 PRD / architecture，guides 不得开口子：

- 不做实时干预，不代理运行中的 agent；只读 live 页不得改编排
- **live ≠ 盯 coding agent**：同步的是 Distiller 自己的裁剪过程与结果
- 不做失败 Trace 分析
- 不改模型权重
- 不做完整 GUI / 账号体系；蒸馏主链路仍离线。为本机复盘允许轻量只读本地页；事后 Playback 仍是自包含 HTML
- 不用 LangChain / CrewAI 编排；LLM 不决定切段粒度或步骤顺序
- 不把重放成功率塞进每个打标窗口
- 不抄 macaron 的 remote / middleware / 在线 observability

### 与 `docs/modules` 的分工

| | `docs/guides/` | `docs/modules/` |
|--|----------------|-----------------|
| 问题 | 怎么用、边界、和产品叙事怎么接 | 这个目录准做什么、输入输出、完成勾选 |
| 改它当 | 操作说明过时 | 实现与契约不一致 |
| 不要 | 复制字段表、把 OPEN 假装已定 | 写「一天怎么跑通」的用户教程 |

冲突时：洞流程以 ADR-0009 为准，分层以 architecture v0.3 为准，产品词以 CONTEXT 为准。

### OPEN 问题入口

未拍板的不在 guides 里私自定案。总入口：[docs/TODO.md](../TODO.md)。

动工前置（P0）仍卡在 **AgentView Trace JSON 结构体**、盲测判分协议等。token 口径、session ≠ trace 切分、GT / 锚点 / sig / Action Unit 切段等已在 [ingest-and-preprocess.md](./ingest-and-preprocess.md) 收成默认。各 guide 文末剩余「开放问题」链回 TODO / 对应 module，关闭时改 TODO 和 ADR，而不是只改 guide。

## 边界（非目标）

- 本目录不取代 PRD / architecture / ADR。
- 不在这里写 `src/` 实现代码。
- 不把 modules 的字段表抄一遍。
- 三路 guides 并行撰写，合并后若有交叉重复，以 ADR 为准做删减，不在索引里发明第三套说法。

## 开放问题

索引本身没有新的设计 OPEN。各篇文末的问题以 TODO 为准。若合并后发现某篇 guide 和 ADR 打架，改 guide。

## 完成标准

- [ ] 上表文件都在 `docs/guides/`，链接能点开。
- [ ] 阅读顺序能让没写过代码的人走到「怎么证明剪好了」。
- [ ] 「CutProfile / 成本 / 明确不做 / 与 modules 分工 / OPEN 入口」五件事在本页能找到落点。
- [ ] 没有任何一篇 guide 把 Distiller 写成单一 Runtime Agent，或把 Gateway 写成在线网关。

## 相关文档

- [PRD.md](../../PRD.md) / [CONTEXT.md](../../CONTEXT.md) / [architecture.md](../architecture.md)
- [docs/adr/](../adr/) / [docs/modules/](../modules/) / [docs/TODO.md](../TODO.md)
- [benchmark/README.md](../../benchmark/README.md)
