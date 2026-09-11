# Trace Distiller 架构

| 字段 | 内容 |
|------|------|
| 版本 | v0.3 |
| 日期 | 2026-08-30 |
| 状态 | 已批准 |
| 语言 | **TypeScript + Node（bun 装依赖，node 跑产物）** |

> v0.3 变更：目录结构按 macaron-agent 分层纪律重排（types/enums/constant/domain 前置、biz 与 service 分离、data 层统一管 SQLite）；新增展示层——自包含 HTML 报告（report/）。流水线 + 两洞的核心架构不变。

## 核心观念

> Agent session 任 **editor-in-chief** 决定 how to cut；确定性 TS 护栏保证可复现（[ADR-0010](./adr/0010-agent-led-cut-with-tool-mask.md)）。

不用 LangChain / CrewAI。pi 只经 `src/agent/sessions/`（可托管 cut-brain 会话循环）。工具结果经 **tool mask** 回灌；全量 payload 进 warrant/training store。

```text
Agent-led cut（sessions cut-brain / 洞 A+B；follow-up 完整 ReAct）
│
├─ L0 适配器      → 纯代码（各格式 parser）
├─ L1 切段+规则   → 纯代码（亦可作 agent 可选工具/hints）
│
├─ ① 骨架 pass    → 【Agent 洞 A】pi SDK
├─ ② 逐窗打标     → 【Agent 洞 B】pi SDK（骨架注入；tool mask）
│
├─ ③ warrant+assemble → 纯代码校验（span / CutWarrant / 双产物）
├─ L3 导出        → 纯代码
└─ L4 评测        → 纯代码统计 + 重放用 pi 起干净会话
```

**为什么护栏仍是纯代码**：admission / span / assemble / I/O 必须可复现；agent 只拥有裁剪判断权，不拥有校验与落盘权。

一句话映射：

> Agent 决定怎么切；确定性代码保证切得合法、可复现；tool mask 管住上下文；skill 承载场景策略；SQLite 承载评测闭环。

---

## 技术选型

| 层 | 选型 | 理由 |
|----|------|------|
| 语言/运行时 | TypeScript + Node | pi 为 TS 原生；全家桶一个技术栈，类型贯通 |
| 编排器 | 自写薄 CLI（不用 LangChain / CrewAI） | 流水线确定；框架只会加黑盒；`orchestrator.ts` + 任务队列即可 |
| Agent 内核 | pi SDK（`createAgentSession()`） | 两洞需要程序化嵌入的 LLM 会话；支持 Anthropic / OpenAI / 自定义；Azure 可接 |
| 打标 prompt | pi Skills / Prompt Templates（Markdown） | 每个裁剪场景 = 一个 skill 文件；可单独迭代、可版本化 |
| 模型 | 打标用强模型（Claude Sonnet 级）；骨架 pass 可用更强档 | pi 低脚手架依赖强模型；QA 生成可降档省成本 |
| 存储 | JSONL（I/O）+ SQLite（打标结果、评测指标） | 原料本是 JSONL；指标要可查询对比；SQLite 单文件零运维 |
| 评测重放 | pi 起干净会话跑任务 | 与打标同内核，环境一致 |

---

## 展示层：自包含 HTML 报告（不做 GUI / web 服务）

Demo 的核心镜头是「500 步的墙 → 30 步的精华」，载体是**流水线最后一步导出的单个 .html 文件**（内嵌结果 JSON + vanilla JS，零依赖、零服务器）：

- 组会投屏双击打开；发文件即演示。
- HTML 报告就是 Playback Cut（给人看的产物）的实例化；Training Cut 继续是 JSONL，不需要 UI。
- 报告里每个被删段落可点开：删除理由 + 打标来源（规则名 / 洞 B 标签 + 置信度）。**可解释的裁剪是信任来源**，也是区别于「光给一条短 trace」的卖点。
- 成本可视化必放首页：规则层处理了多少段、LLM 只看了百分之几——这是第二个卖点。

明确不做：Electron/Tauri 桌面 GUI（一周工作量，零增益）；本地 web server（demo 无法传播）。`report/` 与 `eval/` 分开：eval 出数字，report 出给人看的东西。

## 内核：薄包 pi SDK，不引入 agent 框架

系统是 **agent 主编 + 确定性流水线护栏**。洞函数放 `agent/sessions/`（后续 cut-brain 循环也只许落这里）：

```text
skeletonPass(trace)                          → 骨架 + 场景分类（洞 A，强模型）
labelWindow(segments, skeleton, skill)      → 四类标签 + 置信度（洞 B）
```

场景分类不单独烧调用：它是洞 A 骨架 pass 的副产品输出（`scenario` 字段），orchestrator 拿它查 skill 路由表（`constant/`），确定性路由。工具只有 `label_segment` / `check_continuity` 两个，不加第三个——工具越多洞里的 LLM 越分心，成本卖点就没了。



## 分层与职责

### L0 `adapters/` — 纯代码

- pi session / Claude Code / SWE-bench 等 → 规范 Trace
- 只解析对齐；不做打标、不剪辑
- 无 Ground Truth → 拒绝进入流水线

### L1 切段 + 规则 — 纯代码

- `segmenter.ts`：按 Action Unit 切段  
- `rules.ts`：失败调用、重复读、相似重试等规则打标  
- 规则能定的尽量在进洞之前定完  

### Agent 洞 A — 骨架 pass（pi）

- 对整条（或规约后的）Trace 抽出**因果骨架**：关键转折、主路径假设  
- 产出写入 SQLite / 工作区，供洞 B 每窗注入 system context  
- 模型档位可高于日常打标  

### Agent 洞 B — 逐窗打标（pi）

- 编排器读段队，map-reduce 逐窗开会话  
- 输入：段 + 骨架 context；输出：四类标签 + 置信度  
- 全局重组时的**衔接检查**也走洞 B 会话（一次 LLM，不是再开编排 agent）  

### ③ `assembler.ts` — 全局重组

- 纯代码按标签保留 / 一句压缩死胡同 / 删例行  
- **Span Constraint（够得着）**在此强制；不过则失败或回退策略（仍由纯代码决定）  
- 必要时调洞 B 做相邻步连贯性检查  

### L3 导出 — 纯代码

- Training Cut / Playback Cut；同源 CutPlan  

### L4 `eval/` — 评测

- 压缩率、成本比等：纯统计  
- QA 生成：可降档模型  
- 重放：pi 起**干净会话**跑任务  
- 正式复合分与分档赛道见 [benchmark/README.md](../benchmark/README.md)  

---

## pi 二开：三件事

### 1. 一个 extension

注册自定义工具（prompt 模板放 `skills/`）：

| 工具 | 输入 → 输出 |
|------|-------------|
| `label_segment` | 段 + 骨架 → 四类标签 + 置信度 |
| `check_continuity` | 相邻段 → 衔接是否够得着（及分数/理由） |

### 2. map-reduce 驱动（编排器侧，不必改 pi）

- 读 SQLite 段队 → 逐窗 `createAgentSession()`  
- 骨架 pass 产物注入每窗 system context  
- SDK 原生支持自定义消息序列即可  

### 3. 失败兜底

- 优先要 pi 的结构化 / JSON 模式输出  
- 解析失败或超 token 的窗口：**自动降级为「保守不裁」**（宁多勿漏，对齐召回优先阈值）  

---

## 目录结构

按 macaron-agent 分层纪律重排：**types / enums / constant / domain 前置（契约先于实现）；biz 纯逻辑与 service 入口薄壳分离；所有库操作走 data 层**。

```text
trace-distiller/
├─ AGENTS.md              # 工程规则：命令、TS 风格、分层纪律
├─ package.json           # bun 装依赖、node 跑产物；typecheck / lint / test scripts
├─ tsconfig.json / tsconfig.build.json / eslint.config.js
├─ script/
│  └─ run-distill.ts      # CLI 入口：distill <trace.jsonl> [--report out.html]
├─ src/
│  ├─ types/              # Trace 契约：trace.ts segment.ts label.ts cut_plan.ts
│  ├─ enums/              # label_enum.ts scenario_enum.ts agent_role_enum.ts（每 enum 一文件）
│  ├─ constant/           # 压缩率目标、窗口大小、保守不裁阈值、skill 场景路由表
│  ├─ domain/             # LabelDecision / CutDecision / SpanViolation 纯模型
│  ├─ adapters/           # L0: pi session / claude-code / swebench → 规范 Trace
│  ├─ pipeline/           # biz 层：segmenter.ts rules.ts orchestrator.ts assembler.ts
│  ├─ agent/              # pi 二开（仅两洞）
│  │  ├─ sessions/        # skeletonPass / labelWindow（唯一 pi 依赖点）
│  │  ├─ extension.ts     # label_segment / check_continuity / keep_segment / apply_rules_hint
│  │  └─ skills/           # 分场景裁剪 skill（Markdown）
│  ├─ data/               # SQLite：打标结果、指标（biz 不直接碰库）
│  ├─ eval/               # L4: 指标统计 + QA + 重放
│  ├─ service/            # 入口薄壳：cli.ts（命令）、report.ts（调 renderer）
│  ├─ report/             # HTML 报告渲染（纯函数：结果 JSON → html 字符串）
│  └─ utils/              # 仅无状态小函数：token 估算、jsonl 读写、logger
│                         # 状态相关的一律进 domain / data，不许堆 utils
├─ tests/                 # biz 层单测为主
├─ examples/              # 3–5 条原料 + 跑出的报告（demo 素材）
├─ data/                  # 运行时原料与产物（大文件 gitignore）
├─ benchmark/             # 数据集 + 基线报告
└─ docs/                  # 架构、里程碑、ADR
```

与 macaron-agent 的对应：**biz → pipeline + agent；service → service/cli；data/Mongo → data/SQLite**。macaron 的 remote / middleware / decorator / response / observability（在线服务那套）不抄——离线工具的 observability 就是 SQLite 打标表 + 报告里的成本统计。

MVP 先固定 **3–5 个** skill 文件，再扩场景。

---

## 三条活口（有意保留）

| 活口 | 做法 |
|------|------|
| **skill 热更新** | skills 为 Markdown；后期「skill 自优化」只需给洞 B 加 `rewrite_skill`，目录不用动 |
| **模型可换** | 两洞走 pi provider 抽象；打标升/降档后 benchmark A/B 即可 |
| **内核可换** | 编排器与洞之间只经 `agent/sessions/`；pi 撑不住时替换成本限制在该目录 |

---

## 与旧方案的关系

| v0.1（已废弃） | v0.2（现行） |
|----------------|--------------|
| 自主 Agent 运行时编排整条链路 | **纯 TS 流水线编排** |
| ScriptedPolicy / AgentPolicy | **无编排 agent**；仅洞 A / 洞 B |
| 语言未定 | **TypeScript + Node + pi** |
| Brain/Label/Judge 三端口在「一个 runtime」里 | 预算仍分账，但落在**骨架 pass / 打标窗 / 评测重放**三类会话上 |

ADR-0006 已由 [0008](./adr/0008-pipeline-plus-two-agent-holes.md) 取代。

---

## 落地顺序（建议）

1. `types/` + `enums/`：Trace 契约（JSONL schema）——一切的前提，纯设计活不依赖原料  
2. L0 适配器（先 Claude Code / JSONL）+ `segmenter` + `rules` + SQLite 段表  
3. `orchestrator` 串 L0→L1→（跳过洞）→保守导出，打通压缩率统计  
4. `report/` HTML 报告骨架——demo 骨架提前到 M1 中段就有，报告要边做边录讲解视频  
5. 洞 A 骨架 pass（pi session 封装 + 场景分类输出）  
6. 洞 B `label_segment` + map-reduce + skill×3  
7. `assembler` + `check_continuity` + 双产物导出  
8. `eval/`：QA + 成本比；重放接 benchmark  

---

## 明确不做

- 用 LangChain / CrewAI 等编排整条 Distiller  
- 让 LLM 决定切段粒度、流水线步骤顺序或重试策略  
- 把重放成功率塞进每个打标窗口（太贵；属 L4 / 发布门禁）  
- MVP 先做 GUI；也不做本地 web server——展示层只做自包含 HTML 报告导出  
