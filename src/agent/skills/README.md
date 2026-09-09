# agent/skills

分场景裁剪策略的 Markdown 目录。洞 B 按洞 A 给出的 `scenario` 查 `SKILL_ROUTE` 选用文件；本目录**不含** TypeScript，也不是编排脚本。

## 现在不要当完成

**Scenario 名单未拍板**（`src/enums/scenario.ts` 的类型是 `unknown`；`src/constant/skill_route.ts` 的 `SKILL_ROUTE` 是空表）。没有名单就不能写死文件名，也不能假装已有 skill 路由。

因此本目录目前**只有这份 README**。不要在这里放 `debug.md` / `implement.md` / `refactor.md` / `_shared.md` 等占位正文，去冒充 M2「skill × 3–5」已完成。假文件会让路由表和场景码看起来已接通，实际洞 A/B 仍是 `NotImplementedError`。

名单批准前：

- 禁止新增场景 `.md` 冒充路由完成。
- 禁止在 Markdown 代码块里藏 TS 当实现。
- 禁止把 Jaccard、窗口大小、span、keep/drop 写进 skill；那些分别属于 constant / 凭证 / CutProfile。

名单拍板后，按 [docs/modules/agent-skills.md](../../../docs/modules/agent-skills.md) 补 `_shared.md` + 已批准场景文件，并使路由表键与文件名一致。那才算 M2 skill 落地，不是现在。
