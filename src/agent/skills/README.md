# agent/skills

分场景裁剪策略的 Markdown 目录。洞 B 按洞 A 给出的 `scenario` 查 `SKILL_ROUTE` 选用文件；本目录**不含** TypeScript，也不是编排脚本。

场景名单已拍板：`debug` / `implement` / `refactor` / `test_fix` / `investigate`。查不到回退 `implement`（见 `src/constant/skill_route.ts`）。

每份文件只写洞 B 纪律：按段 `label_segment`、忽略已决议噪音、可 `read_segment` 付费看本段原文、`check_continuity` 1–5、禁止执行类工具。窗口大小、span、Jaccard、keep/drop 不写进 skill。

洞 A/B 可经 `FakeSessionBackend` 接通；真模型需 `TRACE_DISTILLER_MODEL_HOLE_A` / `_HOLE_B`。有 skill 文件 ≠ orchestrator 已接洞，也不等于 M2 prompt 注入防线完成。
