import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/adapters/claude_code.ts'
import { SEGMENT_HEAD_MAX_CHARS } from '../../src/constant/window.ts'
import { segment } from '../../src/pipeline/segmenter.ts'
import type { RawTrace, RawTurn, RawTurnRole } from '../../src/types/raw_trace.ts'
import { estimateTokens } from '../../src/utils/tokens.ts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/claude_code')

function load(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8')
}

function makeTurn(
  id: string,
  role: RawTurnRole,
  content: string,
  tool?: { name: string; args: Record<string, unknown> },
): RawTurn {
  const turn: RawTurn = { id, role, content, tokens: estimateTokens(content) }
  if (tool !== undefined) {
    turn.tool = { name: tool.name, args_json: JSON.stringify(tool.args) }
  }
  return turn
}

function rawOf(turns: RawTurn[]): RawTrace {
  return {
    meta: {
      trace_id: 'synth:segmenter',
      source: 'claude-code',
      ground_truth_ref: 'turn:t-gt',
      total_tokens: turns.reduce((sum, t) => sum + t.tokens, 0),
    },
    ground_truth: { kind: 'tests_passed', evidence_ref: 'turn:t-gt' },
    turns,
    anchor_turn_ids: turns[0] === undefined ? [] : [turns[0].id],
  }
}

describe('segmenter', () => {
  it('cuts the pytest fixture into stable Action Units via the adapter', () => {
    const raw = parse(load('single_task_pytest.jsonl'))
    const a = segment(raw)
    const b = segment(raw)

    assert.deepEqual(
      a.segments.map((s) => s.id),
      ['s0001', 's0002', 's0003', 's0004', 's0005', 's0006', 's0007'],
    )
    assert.deepEqual(
      a.segments.map((s) => s.id),
      b.segments.map((s) => s.id),
    )
    assert.deepEqual(
      a.segments.map((s) => s.raw_refs),
      b.segments.map((s) => s.raw_refs),
    )
    assert.deepEqual(
      a.segments.map((s) => s.tool),
      ['user', 'Read', 'Edit', 'Bash', 'Write', 'Bash', 'assistant'],
    )

    const covered = a.segments.flatMap((s) => s.raw_refs)
    assert.deepEqual(covered, raw.turns.map((t) => t.id))
    assert.equal(covered.length, new Set(covered).size)

    const read = a.segments[1]
    assert.ok(read)
    assert.ok(read.raw_refs.includes('turn-asst-1'))
    assert.equal(read.sig, 'Read:add.ts')
    assert.deepEqual(read.reads, ['add.ts'])
    assert.deepEqual(read.writes, [])
    assert.equal(read.rep_of, null)
    assert.equal(read.focus, 'card')

    const pytest = a.segments[3]
    assert.ok(pytest)
    assert.equal(pytest.outcome, 'ok')
    assert.equal(pytest.sig, 'Bash:pytest tests/test_add.py')
    assert.ok(pytest.tokens >= estimateTokens(raw.turns.find((t) => t.id === 'turn-tool-test')?.content ?? ''))

    const edit = a.segments[2]
    assert.ok(edit)
    assert.equal(edit.outcome, 'ok')  // result present without exit_code → ok (MIMO-friendly)
    assert.deepEqual(edit.writes, ['add.ts'])

    assert.equal(a.intent_hypothesis.version, 0)
    assert.equal(a.intent_hypothesis.text, '')
    assert.equal(a.skeleton.version, 0)
    assert.deepEqual(a.skeleton.nodes, [])
    assert.equal(a.meta.trace_id, raw.meta.trace_id)
  })

  it('hangs thinking on the following tool and splits consecutive tools', () => {
    const raw = rawOf([
      makeTurn('u', 'user', 'fix it'),
      makeTurn('th1', 'thought', 'I will read then edit.'),
      makeTurn('c1', 'tool_call', '{"path":"a.ts"}', { name: 'Read', args: { path: 'a.ts' } }),
      makeTurn('r1', 'tool_result', 'ok\n<exit_code>0</exit_code>'),
      makeTurn('c2', 'tool_call', '{"path":"a.ts"}', { name: 'Edit', args: { path: 'a.ts' } }),
      makeTurn('r2', 'tool_result', 'ok'),
    ])
    const view = segment(raw)
    assert.equal(view.segments.length, 3)
    assert.deepEqual(view.segments[1]?.raw_refs, ['th1', 'c1', 'r1'])
    assert.deepEqual(view.segments[2]?.raw_refs, ['c2', 'r2'])
    assert.equal(view.segments[1]?.tool, 'Read')
    assert.equal(view.segments[2]?.tool, 'Edit')
  })

  it('keeps trailing thought as its own segment without dropping text', () => {
    const thinking = 'Need to reconsider the approach.\nDo not drop this line.'
    const raw = rawOf([
      makeTurn('c1', 'tool_call', '{"path":"a.ts"}', { name: 'Read', args: { path: 'a.ts' } }),
      makeTurn('r1', 'tool_result', 'export const x = 1\n'),
      makeTurn('th', 'thought', thinking),
    ])
    const view = segment(raw)
    assert.equal(view.segments.length, 2)
    const solo = view.segments[1]
    assert.ok(solo)
    assert.equal(solo.tool, 'thought')
    assert.deepEqual(solo.raw_refs, ['th'])
    assert.equal(solo.head, 'Need to reconsider the approach.')
    assert.ok(solo.head.includes('reconsider'))
    assert.equal(solo.head.includes('摘要'), false)
    assert.equal(solo.head.includes('The agent'), false)
    assert.equal(thinking.includes(solo.head), true)
  })

  it('uses the original first line as head, not a summary, and caps at SEGMENT_HEAD_MAX_CHARS', () => {
    const first = 'Read the file and inspect the failing assertion in add.ts exactly as written.'
    const body = `${first}\nSecond line must not become the head.`
    const raw = rawOf([
      makeTurn('th', 'thought', body),
      makeTurn('c1', 'tool_call', '{"path":"add.ts"}', { name: 'Read', args: { path: 'add.ts' } }),
      makeTurn('r1', 'tool_result', 'src'),
    ])
    const head = segment(raw).segments[0]?.head
    assert.equal(head, first)
    assert.notEqual(head, 'Inspected add.ts')
    assert.notEqual(head, 'The model decided to read add.ts')

    const long = 'W'.repeat(4000)
    const longView = segment(
      rawOf([
        makeTurn('th2', 'thought', `${long}\nmore`),
        makeTurn('c2', 'tool_call', '{"path":"z.ts"}', { name: 'Read', args: { path: 'z.ts' } }),
      ]),
    )
    assert.equal(longView.segments[0]?.head, 'W'.repeat(SEGMENT_HEAD_MAX_CHARS))
    assert.equal(longView.segments[0]?.head.length, SEGMENT_HEAD_MAX_CHARS)
  })

  it('builds homogeneous sigs for same-path reads and bash templates after stripping digits/tmp', () => {
    const raw = rawOf([
      makeTurn('c1', 'tool_call', '{"path":"src/add.ts"}', { name: 'Read', args: { path: 'src/add.ts' } }),
      makeTurn('r1', 'tool_result', 'a'),
      makeTurn('c2', 'tool_call', '{"path":"src/add.ts"}', { name: 'Read', args: { path: 'src/add.ts' } }),
      makeTurn('r2', 'tool_result', 'b'),
      makeTurn('c3', 'tool_call', '{"path":"src/mul.ts"}', { name: 'Read', args: { path: 'src/mul.ts' } }),
      makeTurn('r3', 'tool_result', 'c'),
      makeTurn('c4', 'tool_call', '{"command":"cd /tmp/run42 && pytest tests/test_add.py"}', {
        name: 'Bash',
        args: { command: 'cd /tmp/run42 && pytest tests/test_add.py' },
      }),
      makeTurn('r4', 'tool_result', '<exit_code>1</exit_code>'),
      makeTurn('c5', 'tool_call', '{"command":"cd /tmp/run99 && pytest tests/test_add.py"}', {
        name: 'Bash',
        args: { command: 'cd /tmp/run99 && pytest tests/test_add.py' },
      }),
      makeTurn('r5', 'tool_result', '<exit_code>0</exit_code>'),
      makeTurn('c6', 'tool_call', '{"query":"add impl"}', { name: 'UnknownTool', args: { query: 'add impl' } }),
      makeTurn('r6', 'tool_result', 'hit'),
      makeTurn('c7', 'tool_call', '{"query":"add impl"}', { name: 'UnknownTool', args: { query: 'add impl' } }),
      makeTurn('r7', 'tool_result', 'hit2'),
    ])
    const sigs = segment(raw).segments.map((s) => s.sig)
    assert.equal(sigs[0], sigs[1])
    assert.equal(sigs[0], 'Read:src/add.ts')
    assert.notEqual(sigs[0], sigs[2])
    assert.equal(sigs[3], sigs[4])
    assert.equal(sigs[3], 'Bash:cd <tmp> && pytest tests/test_add.py')
    assert.match(sigs[4] ?? '', /<tmp>/u)
    assert.equal(sigs[5], sigs[6])
    assert.equal(sigs[5], 'UnknownTool:add impl')

    const cards = segment(raw).segments
    assert.equal(cards[3]?.outcome, 'error')
    assert.equal(cards[4]?.outcome, 'ok')
    assert.deepEqual(cards[5]?.reads, [])
    assert.deepEqual(cards[5]?.writes, [])
    assert.equal(cards.every((s) => s.rep_of === null), true)
    assert.equal(cards.every((s) => s.focus === 'card'), true)
  })

  it('counts full tool output in segment tokens', () => {
    const output = 'PASS\n' + 'x'.repeat(800)
    const raw = rawOf([
      makeTurn('c1', 'tool_call', '{"command":"pytest"}', { name: 'Bash', args: { command: 'pytest' } }),
      makeTurn('r1', 'tool_result', `${output}\n<exit_code>0</exit_code>`),
    ])
    const card = segment(raw).segments[0]
    assert.ok(card)
    assert.equal(card.tokens, raw.turns[0]!.tokens + raw.turns[1]!.tokens)
    assert.ok(card.tokens > estimateTokens(raw.turns[0]!.content))
  })

  it('pairs batched tool_calls with following tool_results (Claude Code / MIMO parallel tools)', () => {
    const raw = rawOf([
      makeTurn('th', 'thought', 'read three files'),
      makeTurn('c1', 'tool_call', '{"file_path":"a.ts","tool_use_id":"t1"}', {
        name: 'Read',
        args: { file_path: 'a.ts', tool_use_id: 't1' },
      }),
      makeTurn('c2', 'tool_call', '{"file_path":"b.ts","tool_use_id":"t2"}', {
        name: 'Read',
        args: { file_path: 'b.ts', tool_use_id: 't2' },
      }),
      makeTurn('c3', 'tool_call', '{"file_path":"c.ts","tool_use_id":"t3"}', {
        name: 'Read',
        args: { file_path: 'c.ts', tool_use_id: 't3' },
      }),
      makeTurn('r1', 'tool_result', 'A', { name: 'Read', args: { tool_use_id: 't1' } }),
      makeTurn('r2', 'tool_result', 'B', { name: 'Read', args: { tool_use_id: 't2' } }),
      makeTurn('r3', 'tool_result', 'C', { name: 'Read', args: { tool_use_id: 't3' } }),
    ])
    const cards = segment(raw).segments
    assert.equal(cards.length, 3)
    assert.deepEqual(
      cards.map((s) => s.tool),
      ['Read', 'Read', 'Read'],
    )
    assert.equal(cards.some((s) => s.tool === 'tool_result'), false)
    assert.deepEqual(cards[0]?.reads, ['a.ts'])
    assert.deepEqual(cards[1]?.reads, ['b.ts'])
    assert.deepEqual(cards[2]?.reads, ['c.ts'])
    assert.equal(cards[0]?.outcome, 'ok')
    assert.ok(cards[0]?.raw_refs.includes('r1'))
    assert.ok(cards[1]?.raw_refs.includes('r2'))
    assert.ok(cards[2]?.raw_refs.includes('r3'))
  })
})
