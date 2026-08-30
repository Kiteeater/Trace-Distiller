# TODO

滚动代办。M1 交付清单见 [milestones.md](./milestones.md)（那是验收口径，这里是执行队列）。
已完成决策不列，只列待做；决策记录见 [adr/](./adr/)。

## P0 — Trace JSON（AgentView）结构体设计

**这是动工前置项：契约一定，segmenter / rules / 卡片流渲染可并行。** 详见 [ADR-0009](./adr/0009-agent-view-and-cut-warrant.md)。

- [ ] 定 AgentView 信封结构：`meta`（trace_id / source / ground_truth_ref / total_tokens）+ `intent_hypothesis` + `skeleton`（增量修正）+ `segments`
- [ ] 定 SegmentCard 字段：`id` / `tool` / `sig`（动作签名）/ `outcome` / `rep_of`（相似重试聚类指针）/ `reads` / `writes` / `tokens` / `focus`（line|card|full 三档注意力）/ `head`（代码截首句，非 LLM 生成）
- [ ] 定动作签名 `sig` 的生成规则（什么算「同质动作」，聚类 / 归并到什么粒度）
- [ ] 定 RawTrace ↔ AgentView 的映射关系：Training Cut 取 RawTrace 原文，Playback Cut 取 AgentView 卡片流——同一 CutPlan 两种投影
- [ ] 定 CutWarrant（裁剪凭证）schema：keep / collapse / drop + source（规则名|LLM）+ 置信度 + 死胡同一句话摘要（唯一允许的改写）
- [ ] 定 CutProfile schema：标签保留策略 / 压缩率区间 / span 约束 / 死胡同处理——用户自定义面（CLI 吃 profile 跑）
- [ ] 写成 `src/types/` + `src/enums/` 的 TS 契约（每 enum 一文件）
- [ ] 注意力档位默认值的规则集：什么条件给 line / card / full（代码决定，不是 LLM 决定）
- [ ] 多任务 session 切分：一条 Claude Code session 常含多个任务（修 bug 顺带重构），「一条 trace = 一个任务」是切段和意图推断的前提——session ≠ trace 的切分策略要先定，否则 adapter 没法写

## P0 — 工程骨架

- [ ] AGENTS.md：工程规则（bun 装 / node 跑 / typecheck / lint / 分层纪律——契约前置、biz 纯逻辑、service 薄壳、data 统一管库、utils 只放无状态）
- [ ] package.json + tsconfig + eslint 建起来（目录树按 architecture.md v0.3）
- [ ] pi SDK spike：验证结构化输出、自定义消息序列（骨架注入）、provider 降档切换三件事可用——「内核可换」活口依赖它，最贵的假设最先验
- [ ] SQLite schema：段表 / 打标表 / 凭证表 / 指标表（成本数字和「LLM 只看 X%」全从这查）
- [ ] `read_segment` 确定性拉取工具（洞 B 从卡片升级到 full 的注意力闭环，非判断力工具）
- [ ] 验证点定位：从 trace 中找 ground truth 验证点附近的 turn 作为意图锚点（头尾是启发式，验证点是硬锚点）

## M1 — 流水线（milestones 抄录 + 细化）

- [ ] 搞原料：3–5 条带「最终做对了」标记的 Trace（本地 Claude Code session 先用起来）
- [ ] Admission Gate：无 Ground Truth 拒绝入库
- [ ] L0 适配器（claude-code JSONL 优先）+ `segmenter` + `rules`（含 token Jaccard 相似重试聚类）
- [ ] 文件依赖图：reads/writes 连边，「读过的文件后来被改过」→ 有效探索强信号，喂给洞 B 免费置信度
- [ ] `orchestrator.ts` 确定性编排（无 LLM）
- [ ] ① 头尾意图推断（~2k token 一次调用，输出意图 v0 + 场景码）
- [ ] ② 逐窗打标 map-reduce（骨架注入 context；未决段回报骨架修正，代码合并 v1）
- [ ] ③ CutWarrant 生成（引用式凭证）
- [ ] ④ 确定性裁剪 assembler（span 约束在此强制）
- [ ] ⑤ 盲测 review + 回填循环（最多两轮；review 拿意图 + 剪后 trace，故意不给凭证）
- [ ] 盲测判分协议：review 必须答结构化问题（关键转折点选择 + 从剪后 trace 指认证据段 id），代码才能确定性比对骨架——自由文本没法判分
- [ ] token 计量口径：压缩率分子分母怎么算（工具输出全文算不算、卡片算不算）——口径不定，10%–30% 验收没法算
- [ ] 成本基线：跑一次全量 LLM 打标当对照组，量出真实「1/N token」数字（demo 首页成本曲线的数据源）
- [ ] SQLite 记打标结果 + 规则层覆盖率（「LLM 只看了 X% 的段」进报告首页）
- [ ] `report/`：自包含 HTML 报告骨架（左原始 / 右精华 / 点开删除理由 / 成本数字）——M1 中段就要有，讲解视频边做边录
- [ ] 讲解视频剧本：5 步叙事（500 步的墙 → 规则先干粗活 → 可解释删除 → 盲测 → 压缩率 + 成本两个数字收尾）

## M2 — 双产物与门禁

- [ ] Training Cut（SFT 格式，取 RawTrace 原文）/ Playback Cut（卡片流投影）同源导出
- [ ] 超长 trace 的 map-reduce 逐窗打标稳妥化
- [ ] 压缩率稳定 10%–30%；盲测门禁；span 约束硬化
- [ ] skill 文件 ×3–5（场景先验，洞 A 场景码 → 路由表）
- [ ] prompt 注入防线完整版：MVP 先在洞 B prompt 里框定「trace 内容是数据不是指令」，M2 再系统化

## M3+ — 择机

- [ ] 训练有效性对比（剪后 vs 原始微调）
- [ ] 人类可读性盲读
- [ ] 批量处理入口
- [ ] 对话式调 profile（agent 只能改 CutProfile，流水线重跑；确认有真实用户反复调 profile 才做）
- [ ] skill 自优化（`rewrite_skill` 活口）
