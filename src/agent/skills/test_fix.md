# test_fix

洞 B 纪律：

- 按段调用 `label_segment`，必须带 `segment_id`；标签只许四类。
- 忽略规则已决议的噪音段，不要再标。
- 没把握才 `read_segment`（只看本段原文）。
- `check_continuity` 分数 1–5：前一步能否自然推出后一步。
- 禁止执行类工具（Bash / 读仓库 / 改代码 / keep-drop / edit_trace）。
- 一窗一会话。解析失败由编排器 Fail-Closed Keep。
