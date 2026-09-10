import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 解析 dotenv 行。不执行、不打日志。已存在的非空 env 不覆盖。 */

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2) {
      const q = value[0]
      if ((q === '"' || q === "'") && value[value.length - 1] === q) {
        value = value.slice(1, -1)
      }
    }
    out[key] = value
  }
  return out
}

export function loadEnvFile(path: string, env: NodeJS.Dict<string> = process.env): boolean {
  if (!existsSync(path)) return false
  const parsed = parseEnvFile(readFileSync(path, 'utf8'))
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value
  }
  return true
}

/** 若 cwd 下有 .env 则加载。密钥不得 log。 */
export function loadLocalEnvFile(cwd: string = process.cwd(), env: NodeJS.Dict<string> = process.env): boolean {
  return loadEnvFile(join(cwd, '.env'), env)
}
