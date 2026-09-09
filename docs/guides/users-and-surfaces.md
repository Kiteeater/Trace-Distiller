# 用户与使用面

本工具有两类读者，共用同一条蒸馏主链路，拿走不同产物。自定义面是 **CutProfile**。训练侧主入口是 **CLI**（产物 Training Cut / JSONL）；复盘侧是 **CLI + 只读即时页面**，另有事后自包含 HTML 作为 Playback 产物。

产品词见 [CONTEXT.md](../../CONTEXT.md)。形态决定见 [ADR-0009](../adr/0009-agent-view-and-cut-warrant.md)（CLI + CutProfile，不做完整 GUI）。双产物见 [ADR-0003](../adr/0003-dual-cut-outputs.md)。

相关：[tools.md](./tools.md)（洞内工具与 Live 复盘工具）、[ingest-and-preprocess.md](./ingest-and-preprocess.md)（原料怎么进门）。

---

## 目的

讲清两件事：

1. 你是哪一类读者，该拿走哪份产物、用哪张面。
2. 一天之内，怎么把一条「最终做对了」的 Trace 跑成 Training Cut / 报告，以及复盘时 live 页在同步什么。

不讲字段契约、不讲洞内 prompt。那些在 [docs/modules/](../modules/README.md)。

---

## 读者

| 你是谁 | 你要什么 | 你不该被逼着做什么 |
|--------|----------|---------------------|
| **训练侧** | 一条裁剪后仍正确的 long-horizon **Training Cut**，能当 SFT 数据 | 不必读 HTML、不必开 live 页、不必调版式 |
| **复盘侧** | 看懂 Distiller **自己这次怎么裁**（进度 + Playback），以及事后打开报告 | 不必懂 SFT 格式、不必自己拼因果路径 |

两类人跑的是同一条蒸馏命令、同一份 CutPlan。差别只在导出投影与观察面：训练拿走原文序列；复盘订阅裁剪进度 / 打开报告。禁止为「好看」再剪一套会改因果路径的摘要（ADR-0003）。

本工具只处理成功 Trace。失败分析不是读者面。

**live 的正确定义**：同步的是 **Distiller 自己的裁剪过程与结果**（切段 / 规则 / 洞 / 组装、Partial Playback、CutWarrant 尾部），**不是**盯 Claude Code / 其它 coding agent 的运行进度。

---

## 已定结论

1. **训练侧主入口是 CLI**，产物是 Training Cut / JSONL。产品形态仍是 CLI + 声明式 CutProfile（ADR-0009）：标签保留策略、压缩率区间、span 约束、死胡同怎么留。不做完整 GUI。
2. **复盘侧：CLI + 只读即时页面**。为本机复盘允许开轻量本地页（可破原「不做本地 server」的绝对禁止）；页只订阅进度与部分结果，**绝不干预**蒸馏编排。live 观察与离线蒸馏编排分开。
3. **双产物同源**（ADR-0003）。Training Cut 取 RawTrace 原文，按保留集拼 SFT 序列；Playback Cut 取 AgentView 卡片流。中间标签与保留集只有一份。
4. **事后自包含 HTML 仍是蒸馏产物的 Playback**（[architecture.md](../architecture.md) 展示层），单个 `.html`，内嵌结果 JSON + vanilla JS，双击打开。它是复盘的事后面，**不是**复盘唯一面——跑着的时候看 live 页。
5. **蒸馏主链路仍离线**；原料是磁盘上的成功 Trace。失败 Trace 不进（[ADR-0001](../adr/0001-ground-truth-admission-gate.md)）。无 Ground Truth 当场拒绝，不写「失败原因报告」。
6. **对话调 profile 是 M3 以后的活口**：就算做，agent 也只能改 CutProfile，然后流水线重跑。LLM 永远不进编排 / 执行路径。

CutProfile 的字段级形状在 [types.md](../modules/types.md)；本指南只说它管哪几件事。CLI 入口在 [script-run-distill.md](../modules/script-run-distill.md)。

---

## 怎么用 / 怎么跑

### 训练侧：只要正确的 long-horizon Training Cut

目标：原始几百步里充满死胡同和例行操作；你要一条短、但仍「走得通」的因果路径，拿去 SFT。

- **主入口：CLI**。产物：Training Cut / JSONL（路径约定见下）。
- 原料必须带可验证完成标记（测试通过 / 任务产出被确认）。没有就不进。
- 用默认 CutProfile 即可：保留 **关键决策** + **有效探索**；少量 **代表性死胡同** 压成一句；**例行操作** 删除。压缩率目标 10%–30%（[PRD.md](../../PRD.md)）。
- 关心 span（够得着，[ADR-0004](../adr/0004-span-constraint-reachable.md)）：相邻保留步不能跳太远，否则训练等于喂幻觉。宁可多留一句排除说明，不要剪成悬崖。
- 产物路径约定（[data/distilled/README.md](../../data/distilled/README.md)）：`*-training.*`。M1 可先落一份中间剪后表示；M2 再定 SFT 格式。
- 验收先看两件事：压缩率落在可讨论区间；保真度盲测答得上来（新开对话只喂剪后 Trace）。完整六项指标见 [benchmark/README.md](../../benchmark/README.md)，不是每天都要跑。

训练侧一般**不必**打开 HTML 或 live 页。需要排查「为什么删了关键步」时，再点报告里的删除理由——理由来自 CutWarrant，不是事后让模型编的。

### 复盘侧：CLI + 只读即时页面

目标：一边跑蒸馏，一边看 Distiller **自己**裁到哪了；跑完再打开 Playback HTML。

- 同样要求成功 Trace。你自己的 Claude Code session 可以当原料，但必须先能指出 Ground Truth（见 [ingest-and-preprocess.md](./ingest-and-preprocess.md)）。
- **live 页只读**：订阅切段 / 规则 / 洞 / 组装进度、压缩率暂值、Partial Playback / 卡片流片段、最新一批 keep/drop（工具闭集见 [tools.md](./tools.md)）。纯 TS 推送，不套 LLM。
- **硬边界：只读绝不干预**。页面不能发消息、打断、注入 prompt、代跑对方工具、改蒸馏编排。想换剪法：改 CutProfile，CLI 重跑。
- **live 观察与离线蒸馏编排分开**：编排器照常离线跑；页只挂订阅，不进编排路径。
- **事后自包含 HTML** 仍是蒸馏产物的 Playback（`--report` 写出的 `.html`），双击 `file://` 打开。它是复盘的事后面，不是唯一面。
- **M1 live 页**：蒸馏成功后 `--live-dump <dir>` 写出 `<dir>/<job_id>.live.json` 与 `<dir>/live.html`（内嵌 dump，`file://` 打开）。也可 `live-dump --sqlite` 从最近入库结果导出。页展示 job 列表、进度四格、压缩率、Partial Playback 卡片、warrant 尾；无干预按钮。默认传输 = 进程内 `registerJobFromResult` + dump。禁止 HTTP listen。可选 `--live-socket <path>` 在 distill 期间开本机 Unix domain socket（JSON lines 调同一套 live 工具）；默认关闭；命令结束关闭并 unlink，不 keep-alive。
- 人类可读性盲读（同事 10 分钟复述）是 M3 的事，不进日常自动流水线。

### 一天跑通一条成功 Trace

假设你手头已有一条带 Ground Truth 的 claude-code JSONL（MVP 优先格式），并且它已经是**一个任务**（session ≠ trace，见预处理指南）。

1. **放原料**  
   文件放到 `data/raw/`（或命令行给显式路径）。没有测试通过 / 任务确认标记的，不要指望流水线「看起来像成功」就放行。

2. **选 profile（可跳过）**  
   不传则用默认 CutProfile（压缩率 10%–30%，例行删除，死胡同只留代表句）。想更狠或更保守，改 profile 里的保留标签 / span / 死胡同条数，**不要**改流水线步骤顺序。

3. **跑一条**（落地后的命令草图）

   ```text
   node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--report out.html] [--live-dump dir] [--live-socket path]
   ```

   没有 API key、只想打通切段和规则时：加 `--no-llm`，未决段一律保守保留。这是架构落地顺序里「跳过洞、先出压缩率」的那条路，不是另一种产品。

4. **看出口**  
   - 训练：`data/distilled/*-training.*`（JSONL / Training Cut）  
   - 复盘（M1 live）：`--live-dump dir` 后双击 `dir/live.html`（`file://`），看 Distiller 裁剪进度 / Partial Playback / warrant 尾  
   - 复盘（事后报告）：`--report` 的 html，双击打开（`file://`）  
   - 日志走 stderr；准入拒绝应非 0 退出，且**不写** distilled 产物

5. **过一眼保真**（当天能做的最小版）  
   新开一个对话，只贴剪后 Trace（或报告右侧精华），问「这个 agent 是怎么解决的、关键转折在哪」。答不上来：先看是剪过头还是标签错，再调 profile / 把问题记回 [TODO.md](../TODO.md)，不要在报告里手改因果顺序。

一条一天，不要一开始就 glob 批量（批量是 M3）。

### 看报告时点什么

报告信息架构按讲解视频五步走（[report.md](../modules/report.md)），不是普通 dashboard。打开之后按这个顺序看：

| 先看 | 点哪里 | 你在验证什么 |
|------|--------|----------------|
| **墙 → 精华** | 首页左右步数、压缩率 | 有没有真的变短；是否短到不像话（远低于 10% 要怀疑剪过头） |
| **成本** | 首页：规则层处理了多少段、LLM 只看了百分之几、处理成本比 | 第二个卖点：工具自己不能是成本黑洞。规则覆盖率低、LLM 几乎全量打标，说明前端规则没干活 |
| **删除理由** | 右侧精华里被删 / 被压成一句的段，点开 | CutWarrant：`keep / collapse / drop` + source（规则名或洞 B）+ 置信度；死胡同那一句摘要。可解释的裁剪是信任来源 |
| **盲测** | 结论区（有则看） | 通过 / 未通过、回填了几轮。review 故意不看凭证，答不上来不是「报告文案不够漂亮」 |

不要做的事：在 HTML / live 页里改 CutProfile、重新跑流水线、外链打开原始仓库文件。发给别人的 html 必须自包含。

Training Cut 默认不要铺满报告——太长。墙在左边用卡片索引即可。

---

## 边界（非目标）

- **蒸馏主链路仍离线**。原料是磁盘上的成功 Trace（JSONL 等），不是在线代理对方 agent。
- **复盘另有只读 live 面**：为本机复盘可开轻量本地页；页只订阅 Distiller 自己的裁剪进度与结果，**绝不干预**。这不是盯 Claude Code / 其它 coding agent 的运行进度，也不是 IDE profiler。
- **不做完整 GUI / 不做账号体系 / 不做分享链接产品**。事后展示层仍有自包含 `.html`；live 页是复盘订阅面，不是第二套编排 UI。
- **不分析失败 Trace**。无 Ground Truth 拒绝入库；不写失败原因报告。
- **不改模型权重**。Training Cut 是数据，不是训练器。
- **不在报告里再摘要一次**。keep 段内容不得为版面改写。
- **不把 CutProfile 做成第三套编排**。CLI 的 flag 必须映射成 profile / DistillInput 上的显式字段，由编排器解释（[service.md](../modules/service.md)）。

自定义面三件套（ADR-0009）：CutProfile（剪法）+ skill 文件（场景先验，洞 B 用）+ adapter（新原料格式）。日常用户只碰前一个；后两个是扩展，不是每天的使用面。

---

## 开放问题

1. **CutProfile 落地文件格式**：ADR-0009 写声明式 TS 类型 + 默认值；运行时 JSON 更省事。CLI 先吃哪种，未拍板（[service.md](../modules/service.md)）。
2. **退出码与门禁**：建议 0 成功、2 准入拒绝、3 span 失败、4 review 门禁失败（M2 才当门禁）。M1 盲测不及格是继续出报告还是非零退出，要书面结论。
3. **stdout 一行 JSON vs 纯人类日志**：机器摘要（trace_id、压缩率）是否打 stdout，未拍板。
4. **报告内嵌体积**：500 段 full 原文会让 html 巨大。建议内嵌卡片 + 删除理由 + keep 的 head；未拍板。
5. **对话调 profile**：确认有真实用户反复调才做（TODO M3）。在此之前不要做聊天壳。
6. **live 页传输**：默认 = 进程内 `registerJobFromResult` + `file://` dump。禁止 HTTP listen。可选 Unix domain socket（`--live-socket`，默认关闭）是另一扇只读窗，不替代进程内表。

---

## 完成标准

本使用面算就绪，当且仅当：

- [x] 训练侧能用一条 CLI 命令拿到 `*-training.*`（Training Cut / JSONL），且与 Playback 同源（同一 CutPlan）。
- [x] 复盘侧 M1：`--live-dump` 写出只读 live.html（进度 / Partial Playback / warrant 尾），`file://` 打开；事后 `--report` html（左原始 / 右精华 / 点开删除理由 / 首页成本）。不是跑着时的 HTTP 订阅。
- [x] live 页无干预能力（无 send / interrupt / inject / 改编排）；与离线编排进程分离。
- [x] 无 Ground Truth 的输入非 0 退出，不写 distilled。
- [x] 仓库里没有完整 GUI / Electron / 账号体系入口；为本机复盘允许的轻量本地页不得变成第二套编排 UI。
- [x] `--help` 能讲清两类产物、CutProfile，以及 live 同步的是 Distiller 裁剪而非对方 agent。
- [x] README「怎么跑」与 `script/run-distill.ts` 命令一致。
- [x] 本文件不把 types 字段说明书再抄一遍；读者被链到 modules 即可继续。
