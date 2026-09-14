/** Promise 硬超时。超时后 reject，并清掉 timer。可选 AbortSignal 取消等待（不取消底层 promise）。 */

export const ABORT_ERROR_NAME = 'AbortError' as const
export const ABORT_ERROR_MESSAGE = 'The operation was aborted' as const

/** Recognizable abort error (`name === 'AbortError'`). */
export function createAbortError(message: string = ABORT_ERROR_MESSAGE): Error {
  const err = new Error(message)
  err.name = ABORT_ERROR_NAME
  return err
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === ABORT_ERROR_NAME
}

export function abortErrorFromSignal(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (isAbortError(reason)) return reason as Error
  return createAbortError()
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortErrorFromSignal(signal)
}

/** If `err` is abort or `signal` is aborted, throw AbortError; otherwise no-op. */
export function rethrowIfAborted(signal: AbortSignal | undefined, err: unknown): void {
  if (isAbortError(err)) throw err
  if (signal?.aborted) throw abortErrorFromSignal(signal)
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw abortErrorFromSignal(signal)
  const timed = Number.isFinite(ms) && ms > 0
  if (!timed && signal === undefined) return promise

  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        if (signal !== undefined && abortListener !== undefined) {
          signal.removeEventListener('abort', abortListener)
        }
        fn()
      }
      abortListener = (): void => settle(() => reject(abortErrorFromSignal(signal)))
      if (signal !== undefined) {
        signal.addEventListener('abort', abortListener, { once: true })
        if (signal.aborted) {
          abortListener()
          return
        }
      }
      if (timed) {
        timer = setTimeout(() => {
          settle(() => reject(new Error(`${label} timed out after ${ms}ms`)))
        }, ms)
      }
      promise.then(
        (value) => settle(() => resolve(value)),
        (err: unknown) => settle(() => reject(err)),
      )
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener)
    }
  }
}

/** 解析会话超时。非法 / 缺省 → fallback。 */
export function resolveTimeoutMs(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim().length === 0) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}
