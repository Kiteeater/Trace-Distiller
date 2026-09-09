/** 无状态最小 logger。只打 stderr，不写文件、不持有级别配置、不记审计表。 */

export type LogLevel = 'info' | 'warn' | 'error'

export function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  let line = `[${level}] ${msg}`
  if (extra !== undefined) {
    line += ` ${JSON.stringify(extra)}`
  }
  process.stderr.write(`${line}\n`)
}

export function info(msg: string, extra?: Record<string, unknown>): void {
  if (extra === undefined) log('info', msg)
  else log('info', msg, extra)
}

export function warn(msg: string, extra?: Record<string, unknown>): void {
  if (extra === undefined) log('warn', msg)
  else log('warn', msg, extra)
}

export function error(msg: string, extra?: Record<string, unknown>): void {
  if (extra === undefined) log('error', msg)
  else log('error', msg, extra)
}
