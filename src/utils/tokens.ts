/**
 * OPEN: tokenizer / 是否对齐 provider 未锁。docs/modules/utils.md §6。
 * 估算不得冒充压缩率官方口径。
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}
