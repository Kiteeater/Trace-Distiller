import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { claudeCodeAdapter, parse, sniff } from '../../src/adapters/claude_code.ts'
import { AdmissionError } from '../../src/types/raw_trace.ts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/claude_code')

function load(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8')
}

function thrownCode(fn: () => unknown): string {
  try {
    fn()
    return 'no_throw'
  } catch (error) {
    if (error instanceof AdmissionError) return error.code
    throw error
  }
}

describe('claude_code adapter', () => {
  it('sniffs synthetic claude-code JSONL and rejects junk', () => {
    assert.equal(sniff(load('single_task_pytest.jsonl')), true)
    assert.equal(sniff('{"foo":1}\n'), false)
    assert.equal(sniff(''), false)
    assert.equal(claudeCodeAdapter.source, 'claude-code')
  })

  it('parses a single-task session with last successful pytest as GT', () => {
    const raw = parse(load('single_task_pytest.jsonl'))
    assert.equal(raw.meta.source, 'claude-code')
    assert.equal(raw.meta.trace_id, 'claude-code:sess-single-pytest')
    assert.equal(raw.ground_truth.kind, 'tests_passed')
    assert.equal(raw.ground_truth.evidence_ref, 'turn:turn-tool-test')
    assert.equal(raw.meta.ground_truth_ref, raw.ground_truth.evidence_ref)

    const tools = raw.turns.filter((t) => t.role === 'tool_call').map((t) => t.tool?.name)
    assert.deepEqual(tools, ['Read', 'Edit', 'Bash', 'Write', 'Bash'])

    const firstUser = raw.turns.find((t) => t.role === 'user')
    assert.ok(firstUser)
    assert.ok(raw.anchor_turn_ids.includes(firstUser.id))
    assert.ok(raw.anchor_turn_ids.includes('turn-tool-test'))
    assert.equal(raw.anchor_turn_ids.includes('turn-asst-tail'), false)
    assert.ok(raw.meta.total_tokens > 0)
  })

  it('returns the same trace_id on two parses and does not emit random ids', () => {
    const text = load('single_task_pytest.jsonl')
    const a = parse(text)
    const b = parse(text)
    assert.equal(a.meta.trace_id, b.meta.trace_id)
    assert.equal(a.anchor_turn_ids.join(','), b.anchor_turn_ids.join(','))
    assert.match(a.meta.trace_id, /^claude-code:/)
    assert.doesNotMatch(a.meta.trace_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/i)
  })

  it('prefers explicit GT metadata over tool results', () => {
    const raw = parse(load('explicit_gt.jsonl'))
    assert.equal(raw.ground_truth.kind, 'task_confirmed')
    assert.equal(raw.ground_truth.evidence_ref, 'output/report.md')
    assert.ok(raw.anchor_turn_ids.includes('eg-user-1'))
  })

  it('hashes stably when the session has no id', () => {
    const jsonl = [
      '{"type":"user","message":{"role":"user","content":"Fix add()"},"uuid":"h-user"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"pytest"}}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"PASS\\n<exit_code>0</exit_code>"}]}}',
    ].join('\n')
    const a = parse(jsonl)
    const b = parse(jsonl)
    assert.equal(a.meta.trace_id, b.meta.trace_id)
    assert.match(a.meta.trace_id, /^claude-code:[0-9a-f]{64}$/)
  })

  it('rejects verbal 好了 and non-test exit 0 as no_ground_truth', () => {
    assert.equal(thrownCode(() => parse(load('no_gt_verbal_ok.jsonl'))), 'no_ground_truth')
  })

  it('rejects unparseable JSONL', () => {
    assert.equal(thrownCode(() => parse(load('unparseable.jsonl'))), 'unparseable')
    assert.equal(thrownCode(() => parse('{"foo":1}\n')), 'unparseable')
    assert.equal(thrownCode(() => parse('')), 'unparseable')
  })

  it('rejects a second new-task user turn and does not split on gitBranch', () => {
    assert.equal(thrownCode(() => parse(load('multi_task.jsonl'))), 'multi_task_ambiguous')
    const sameTask = parse(load('single_task_pytest.jsonl'))
    assert.equal(sameTask.meta.trace_id, 'claude-code:sess-single-pytest')
  })

  it('uses the last successful test, not the earlier failure', () => {
    const raw = parse(load('last_test_wins.jsonl'))
    assert.equal(raw.ground_truth.evidence_ref, 'turn:lt-tool-pass')
    assert.equal(raw.ground_truth.kind, 'tests_passed')
  })
})
