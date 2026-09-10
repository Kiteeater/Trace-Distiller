import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const WORKSPACES_DIRNAME = 'benchmark/workspaces'
export const WORKSPACE_MANIFEST = 'manifest.json'

export interface WorkspaceEntry {
  dir: string
  required_files: string[]
  verify?: string[]
  task_hint?: string
}

export interface WorkspaceManifest {
  version: number
  workspaces: Record<string, WorkspaceEntry>
  trace_map: Record<string, string>
}

export interface ResolvedReplayWorkspace {
  key: string
  abs_dir: string
  entry: WorkspaceEntry
}

/** Load manifest.json under repo_root/benchmark/workspaces. Missing → null. */
export function loadWorkspaceManifest(repoRoot: string): WorkspaceManifest | null {
  const path = join(repoRoot, WORKSPACES_DIRNAME, WORKSPACE_MANIFEST)
  if (!existsSync(path)) return null
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('workspace manifest must be an object')
  }
  const row = parsed as {
    version?: unknown
    workspaces?: unknown
    trace_map?: unknown
  }
  if (typeof row.version !== 'number') throw new Error('workspace manifest needs version')
  if (row.workspaces === null || typeof row.workspaces !== 'object' || Array.isArray(row.workspaces)) {
    throw new Error('workspace manifest needs workspaces map')
  }
  if (row.trace_map === null || typeof row.trace_map !== 'object' || Array.isArray(row.trace_map)) {
    throw new Error('workspace manifest needs trace_map')
  }
  return {
    version: row.version,
    workspaces: row.workspaces as Record<string, WorkspaceEntry>,
    trace_map: row.trace_map as Record<string, string>,
  }
}

/** Map trace_id → fixture workspace absolute path. Unmapped → null. */
export function resolveReplayWorkspace(input: {
  trace_id: string
  repo_root: string
}): ResolvedReplayWorkspace | null {
  const manifest = loadWorkspaceManifest(input.repo_root)
  if (manifest === null) return null
  const key = manifest.trace_map[input.trace_id]
  if (key === undefined) return null
  const entry = manifest.workspaces[key]
  if (entry === undefined) {
    throw new Error(`workspace manifest trace_map points to missing workspace '${key}'`)
  }
  const abs_dir = join(input.repo_root, WORKSPACES_DIRNAME, entry.dir)
  return { key, abs_dir, entry }
}

/** Required files present under cwd. */
export function workspaceReady(cwd: string, requiredFiles: readonly string[]): boolean {
  if (!existsSync(cwd)) return false
  for (const rel of requiredFiles) {
    if (!existsSync(join(cwd, rel))) return false
  }
  return true
}

/**
 * Copy fixture into a unique temp dir so L4 edits do not dirty git.
 * Caller should disposeMaterializedWorkspace when done.
 */
export function materializeReplayWorkspace(absDir: string): string {
  if (!existsSync(absDir)) {
    throw new Error(`replay workspace missing: ${absDir}`)
  }
  const dest = mkdtempSync(join(tmpdir(), 'td-replay-'))
  cpSync(absDir, dest, { recursive: true })
  return dest
}

export function disposeMaterializedWorkspace(cwd: string): void {
  try {
    rmSync(cwd, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
}

/** Ensure parent exists (tests / scripts). */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export interface WorkspaceVerifyResult {
  ok: boolean
  note: string
  exit_code: number | null
}

/**
 * Run workspace verify argv with cwd=fixture copy.
 * Empty argv → ok skipped. Timeout / spawn error → not ok with note.
 */
export function runWorkspaceVerify(
  cwd: string,
  verify: readonly string[],
  opts?: { timeout_ms?: number },
): WorkspaceVerifyResult {
  if (verify.length === 0) {
    return { ok: true, note: 'verify skipped: empty argv', exit_code: null }
  }
  const [cmd, ...args] = verify
  if (cmd === undefined || cmd.length === 0) {
    return { ok: false, note: 'verify failed: empty command', exit_code: null }
  }
  const timeout = opts?.timeout_ms ?? 30_000
  try {
    const r = spawnSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      timeout,
      env: process.env,
    })
    if (r.error !== undefined) {
      return {
        ok: false,
        note: `verify failed: ${r.error.message}`,
        exit_code: r.status,
      }
    }
    if (r.status === 0) {
      return {
        ok: true,
        note: `verify ok: ${verify.join(' ')}`,
        exit_code: 0,
      }
    }
    const errTail = (r.stderr ?? r.stdout ?? '').trim().split('\n').slice(-3).join(' | ')
    return {
      ok: false,
      note: `verify failed (exit ${String(r.status)}): ${verify.join(' ')}${errTail.length > 0 ? ` — ${errTail}` : ''}`,
      exit_code: r.status,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, note: `verify failed: ${message}`, exit_code: null }
  }
}
