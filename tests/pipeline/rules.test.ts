import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { segment } from '../../src/pipeline/segmenter.ts'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import type { LabelDecision } from '../../src/domain/label_decision.ts'
import {
  RULE_EXPLORATORY_LISTING,
  RULE_FAILED_CALL_NO_FOLLOWUP,
  RULE_READ_NEVER_WRITTEN,
  RULE_READ_THEN_LATER_WRITTEN,
  RULE_REPEAT_READ,
  RULE_SEARCH_TOOL,
  RULE_SIMILAR_RETRY,
  applyRules,
  filterRulesForSkeletonProtect,
  ruleWouldDropOrCollapse,
  type RulesOutput,
} from '../../src/pipeline/rules.ts'
import type { RawTrace, RawTurn, RawTurnRole } from '../../src/types/raw_trace.ts'
import { estimateTokens } from '../../src/utils/tokens.ts'

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
      trace_id: 'synth:rules',
      source: 'claude-code',
      ground_truth_ref: 'turn:t-gt',
      total_tokens: turns.reduce((sum, t) => sum + t.tokens, 0),
    },
    ground_truth: { kind: 'tests_passed', evidence_ref: 'turn:t-gt' },
    turns,
    anchor_turn_ids: turns[0] === undefined ? [] : [turns[0].id],
  }
}

function run(turns: RawTurn[]): RulesOutput {
  const raw = rawOf(turns)
  return applyRules({ view: segment(raw), raw })
}

function decisionById(out: RulesOutput, id: string) {
  return out.decisions.find((d) => d.segment_id === id)
}

function assertPartition(out: RulesOutput): void {
  const ids = out.view.segments.map((s) => s.id)
  const decided = out.decisions.map((d) => d.segment_id)
  assert.equal(new Set(decided).size, decided.length)
  assert.equal(new Set(out.unresolved_ids).size, out.unresolved_ids.length)
  for (const id of decided) {
    assert.equal(out.unresolved_ids.includes(id), false)
    assert.equal(ids.includes(id), true)
  }
  for (const id of ids) {
    const inDec = decided.includes(id)
    const inUn = out.unresolved_ids.includes(id)
    assert.equal(inDec || inUn, true)
    assert.equal(inDec && inUn, false)
  }
  for (const d of out.decisions) {
    assert.equal(typeof d.rule_name, 'string')
    assert.ok((d.rule_name ?? '').length > 0)
    assert.equal(d.source.kind, 'rule')
    assert.equal(d.source.name, d.rule_name)
  }
}

describe('rules', () => {
  it('marks a repeat read of the same path with no write in between as routine+line', () => {
    const out = run([
      makeTurn('u', 'user', 'inspect add.ts'),
      makeTurn('c1', 'tool_call', '{"path":"add.ts"}', { name: 'Read', args: { path: 'add.ts' } }),
      makeTurn('r1', 'tool_result', 'export const add = () => {}\n<exit_code>0</exit_code>'),
      makeTurn('c2', 'tool_call', '{"path":"add.ts"}', { name: 'Read', args: { path: 'add.ts' } }),
      makeTurn('r2', 'tool_result', 'export const add = () => {}\n<exit_code>0</exit_code>'),
    ])
    assertPartition(out)

    const first = out.view.segments.find((s) => s.tool === 'Read' && s.rep_of === null && s.id === 's0002')
    const second = out.view.segments.find((s) => s.id === 's0003')
    assert.ok(first)
    assert.ok(second)
    assert.equal(first.sig, second.sig)
    assert.equal(first.focus, 'card')
    assert.equal(out.unresolved_ids.includes(first.id), true)
    assert.equal(decisionById(out, first.id), undefined)

    const d = decisionById(out, second.id)
    assert.ok(d)
    assert.equal(d.label, 'routine')
    assert.equal(d.rule_name, RULE_REPEAT_READ)
    assert.equal(second.focus, 'line')
    assert.equal(out.unresolved_ids.includes(second.id), false)
  })

  it('clusters similar error retries by sig + token Jaccard; members and representative dead_end', () => {
    const errA =
      'FAILED tests/test_add.py::test_add AssertionError expected 3 got 1 in test_add leftover\n<exit_code>1</exit_code>'
    const errB =
      'FAILED tests/test_add.py::test_add AssertionError expected 3 got 1 in test_add\n<exit_code>1</exit_code>'
    const errOther =
      'ModuleNotFoundError completely unique traceback xyzabc cannot import foo\n<exit_code>1</exit_code>'
    const cmd = { name: 'Bash', args: { command: 'pytest tests/test_add.py' } }

    const out = run([
      makeTurn('u', 'user', 'fix tests'),
      makeTurn('c1', 'tool_call', '{"command":"pytest tests/test_add.py"}', cmd),
      makeTurn('r1', 'tool_result', errA),
      makeTurn('c2', 'tool_call', '{"command":"pytest tests/test_add.py"}', cmd),
      makeTurn('r2', 'tool_result', errB),
      makeTurn('c3', 'tool_call', '{"command":"pytest tests/test_add.py"}', cmd),
      makeTurn('r3', 'tool_result', errOther),
    ])
    assertPartition(out)

    const bash = out.view.segments.filter((s) => s.tool === 'Bash')
    assert.equal(bash.length, 3)
    const [a, b, c] = bash
    assert.ok(a)
    assert.ok(b)
    assert.ok(c)
    assert.equal(a.sig, b.sig)
    assert.equal(b.sig, c.sig)

    assert.equal(b.rep_of, a.id)
    assert.equal(a.rep_of, null)
    const member = decisionById(out, b.id)
    assert.ok(member)
    assert.equal(member.rule_name, RULE_SIMILAR_RETRY)
    assert.equal(member.label, 'dead_end')
    assert.equal(b.focus, 'line')

    const rep = decisionById(out, a.id)
    assert.ok(rep)
    assert.equal(rep.rule_name, RULE_SIMILAR_RETRY)
    assert.equal(rep.label, 'dead_end')
    assert.equal(a.focus, 'line')

    assert.equal(c.rep_of, null)
    assert.equal(c.focus, 'line')
    const other = decisionById(out, c.id)
    assert.ok(other)
    assert.equal(other.rule_name, RULE_FAILED_CALL_NO_FOLLOWUP)
    assert.equal(other.label, 'dead_end')
  })

  it('marks pure read_then_later_written as routine; key edit stays unresolved (not key_decision)', () => {
    const out = run([
      makeTurn('u', 'user', 'fix add.ts'),
      makeTurn('c1', 'tool_call', '{"path":"add.ts"}', { name: 'Read', args: { path: 'add.ts' } }),
      makeTurn('r1', 'tool_result', 'export const add = (a,b) => a - b\n<exit_code>0</exit_code>'),
      makeTurn('c2', 'tool_call', '{"path":"add.ts"}', {
        name: 'Edit',
        args: { path: 'add.ts', old_string: 'a - b', new_string: 'a + b' },
      }),
      makeTurn('r2', 'tool_result', 'ok'),
    ])
    assertPartition(out)

    const read = out.view.segments.find((s) => s.tool === 'Read')
    const edit = out.view.segments.find((s) => s.tool === 'Edit')
    assert.ok(read)
    assert.ok(edit)
    assert.equal(read.focus, 'line')
    assert.equal(edit.focus, 'card')
    assert.equal(out.unresolved_ids.includes(read.id), false)
    assert.equal(out.unresolved_ids.includes(edit.id), true)
    const readDec = decisionById(out, read.id)
    assert.ok(readDec)
    assert.equal(readDec.label, 'routine')
    assert.equal(readDec.rule_name, RULE_READ_THEN_LATER_WRITTEN)
    assert.deepEqual(readDec.graph_hints, ['read_then_later_written'])
    assert.equal(decisionById(out, edit.id), undefined)
    assert.equal(
      out.decisions.some((d) => d.label === 'key_decision'),
      false,
    )

    assert.deepEqual(out.graph.nodes, ['add.ts'])
    assert.equal(
      out.graph.edges.some((e) => e.op === 'read' && e.path === 'add.ts' && e.segment_id === read.id),
      true,
    )
    assert.equal(
      out.graph.edges.some((e) => e.op === 'write' && e.path === 'add.ts' && e.segment_id === edit.id),
      true,
    )

    const coverage = out.decisions.length / out.view.segments.length
    assert.equal(coverage < 1, true)
  })

  it('marks similar_retry representative dead_end even when a later write follows the cluster', () => {
    const errA =
      'FAILED tests/test_add.py::test_add AssertionError expected 3 got 1 in test_add leftover\n<exit_code>1</exit_code>'
    const errB =
      'FAILED tests/test_add.py::test_add AssertionError expected 3 got 1 in test_add\n<exit_code>1</exit_code>'
    const cmd = { name: 'Bash', args: { command: 'pytest tests/test_add.py' } }
    const out = run([
      makeTurn('u', 'user', 'fix add'),
      makeTurn('c1', 'tool_call', '{"command":"pytest tests/test_add.py"}', cmd),
      makeTurn('r1', 'tool_result', errA),
      makeTurn('c2', 'tool_call', '{"command":"pytest tests/test_add.py"}', cmd),
      makeTurn('r2', 'tool_result', errB),
      makeTurn('c3', 'tool_call', '{"path":"add.ts"}', {
        name: 'Edit',
        args: { path: 'add.ts', old_string: 'a - b', new_string: 'a + b' },
      }),
      makeTurn('r3', 'tool_result', 'ok'),
    ])
    assertPartition(out)

    const bash = out.view.segments.filter((s) => s.tool === 'Bash')
    const edit = out.view.segments.find((s) => s.tool === 'Edit')
    assert.equal(bash.length, 2)
    assert.ok(edit)
    const [rep, member] = bash
    assert.ok(rep)
    assert.ok(member)
    assert.equal(member.rep_of, rep.id)
    assert.equal(rep.rep_of, null)

    const repDec = decisionById(out, rep.id)
    const memDec = decisionById(out, member.id)
    assert.ok(repDec)
    assert.ok(memDec)
    assert.equal(repDec.rule_name, RULE_SIMILAR_RETRY)
    assert.equal(repDec.label, 'dead_end')
    assert.equal(memDec.rule_name, RULE_SIMILAR_RETRY)
    assert.equal(memDec.label, 'dead_end')
    assert.equal(out.unresolved_ids.includes(edit.id), true)
    assert.equal(decisionById(out, edit.id), undefined)
  })

  it('leaves a failed call unresolved when a later write appears (do not kill useful exploration)', () => {
    const out = run([
      makeTurn('u', 'user', 'fix add'),
      makeTurn('c1', 'tool_call', '{"command":"pytest tests/test_add.py"}', {
        name: 'Bash',
        args: { command: 'pytest tests/test_add.py' },
      }),
      makeTurn(
        'r1',
        'tool_result',
        'FAILED tests/test_add.py::test_add AssertionError\n<exit_code>1</exit_code>',
      ),
      makeTurn('c2', 'tool_call', '{"path":"add.ts"}', {
        name: 'Write',
        args: { path: 'add.ts', contents: 'export const add = (a,b) => a + b\n' },
      }),
      makeTurn('r2', 'tool_result', 'ok'),
    ])
    assertPartition(out)

    const fail = out.view.segments.find((s) => s.tool === 'Bash')
    const write = out.view.segments.find((s) => s.tool === 'Write')
    assert.ok(fail)
    assert.ok(write)
    assert.equal(fail.outcome, 'error')
    assert.equal(fail.focus, 'card')
    assert.equal(out.unresolved_ids.includes(fail.id), true)
    assert.equal(decisionById(out, fail.id), undefined)
    assert.equal(
      out.decisions.some((d) => d.rule_name === RULE_FAILED_CALL_NO_FOLLOWUP),
      false,
    )
    assert.equal(out.unresolved_ids.includes(write.id), true)
    assert.equal(
      out.decisions.some((d) => d.label === 'key_decision'),
      false,
    )
  })
  it('marks ls Bash as exploratory_listing and Glob as search_tool', () => {
    const out = run([
      makeTurn('u', 'user', 'look around'),
      makeTurn('c1', 'tool_call', '{"command":"ls /tmp"}', { name: 'Bash', args: { command: 'ls /tmp' } }),
      makeTurn('r1', 'tool_result', 'a\nb'),
      makeTurn('c2', 'tool_call', '{"pattern":"**/*.ts"}', { name: 'Glob', args: { pattern: '**/*.ts' } }),
      makeTurn('r2', 'tool_result', 'a.ts'),
    ])
    assertPartition(out)
    const ls = out.view.segments.find((s) => s.tool === 'Bash')
    const glob = out.view.segments.find((s) => s.tool === 'Glob')
    assert.ok(ls)
    assert.ok(glob)
    assert.equal(decisionById(out, ls.id)?.rule_name, RULE_EXPLORATORY_LISTING)
    assert.equal(decisionById(out, glob.id)?.rule_name, RULE_SEARCH_TOOL)
  })

  it('marks pure reads never later written as routine when the trace has writes', () => {
    const out = run([
      makeTurn('u', 'user', 'fix'),
      makeTurn('c1', 'tool_call', '{"path":"wrong.ts"}', { name: 'Read', args: { path: 'wrong.ts' } }),
      makeTurn('r1', 'tool_result', 'nope'),
      makeTurn('c2', 'tool_call', '{"path":"add.ts"}', {
        name: 'Write',
        args: { path: 'add.ts', contents: 'ok' },
      }),
      makeTurn('r2', 'tool_result', 'ok'),
    ])
    assertPartition(out)
    const wrong = out.view.segments.find((s) => s.reads.includes('wrong.ts'))
    const write = out.view.segments.find((s) => s.tool === 'Write')
    assert.ok(wrong)
    assert.ok(write)
    assert.equal(decisionById(out, wrong.id)?.rule_name, RULE_READ_NEVER_WRITTEN)
    assert.equal(out.unresolved_ids.includes(write.id), true)
  })

  it('filterRulesForSkeletonProtect withholds drop/collapse on skeleton; keeps keep-mapping', () => {
    assert.equal(ruleWouldDropOrCollapse('routine', DEFAULT_CUT_PROFILE), true)
    assert.equal(ruleWouldDropOrCollapse('dead_end', DEFAULT_CUT_PROFILE), true)
    assert.equal(ruleWouldDropOrCollapse('collapse_uncertain', DEFAULT_CUT_PROFILE), true)
    assert.equal(ruleWouldDropOrCollapse('key_decision', DEFAULT_CUT_PROFILE), false)

    const d = (
      segment_id: string,
      label: LabelDecision['label'],
      name: string,
    ): LabelDecision => ({
      segment_id,
      label,
      source: { kind: 'rule', name },
      confidence: 1,
      rule_name: name,
    })
    const out = filterRulesForSkeletonProtect({
      decisions: [
        d('s1', 'routine', RULE_REPEAT_READ),
        d('s2', 'dead_end', RULE_SIMILAR_RETRY),
        d('s3', 'routine', RULE_REPEAT_READ),
        d('s5', 'key_decision', 'synthetic_keep'),
      ],
      unresolved_ids: ['s4'],
      skeletonIds: new Set(['s1', 's2', 's5']),
      profile: DEFAULT_CUT_PROFILE,
    })
    assert.deepEqual(
      out.decisions.map((x) => x.segment_id),
      ['s3', 's5'],
    )
    assert.equal(out.unresolved_ids.includes('s1'), true)
    assert.equal(out.unresolved_ids.includes('s2'), true)
    assert.equal(out.unresolved_ids.includes('s4'), true)
    assert.equal(out.unresolved_ids.includes('s3'), false)
    assert.equal(out.unresolved_ids.includes('s5'), false)
    assert.equal(out.decisions.find((x) => x.segment_id === 's5')?.label, 'key_decision')
  })

})
