# 只准入带 Ground Truth 的成功 Trace

失败或无法验证完成的 Trace 没有可靠对照，剪辑结果无法谈保真度，也会把脏数据送进 SFT。产品因此硬设 Admission Gate：无 Ground Truth（测试通过 / 任务产出被确认）一律不进流水线；明确不做失败 Trace 分析。

**Status**: accepted

**Consequences**: 原料池变小，但评估与训练侧叙事一致；失败分析若以后要做，必须另开产品边界，不能挤进本工具。
