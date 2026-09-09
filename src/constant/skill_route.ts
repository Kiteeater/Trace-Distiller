/**
 * OPEN: 场景名单未拍板，路由表不能写死。docs/modules/enums.md §6、constant.md §6。
 * 查不到场景码必须硬失败或回退默认 skill，禁止静默空 prompt。
 */
export const SKILL_ROUTE: Record<string, string> = {}
