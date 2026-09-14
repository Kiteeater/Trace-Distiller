import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  isAckOrMaskedRoundMessage,
  prunePromptHistory,
} from '../../src/agent/prompt/compact.ts'
import { composeSessionPrompt, type SessionMessage } from '../../src/agent/prompt/compose.ts'
import { PROMPT_HISTORY_RECENT_ROUNDS } from '../../src/constant/window.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')

const OLD_EVIDENCE = 'OLD_EVIDENCE_SECRET_AAA'
const RECENT_ACK = 'RECENT_ACK_BBB'
const S0_POINTER = 'S0_POINTER_KEEP'
const STATE_PTR = 'STATE_PTR_KEEP'
const RAW_BODY = 'PLANTED_READ_SEGMENT_FULL_BODY_SHOULD_NOT_REENTER'

function pairRound(tag: string): SessionMessage[] {
  return [
    { role: 'assistant', content: `tool_calls: read_segment` },
    {
      role: 'user',
      content: [
        'MASKED_TOOL_RESULTS (ADR-0010/0011; full payloads not re-injected):',
        `read_segment s0001 text_chars=12 head="LINE" marker=${tag}`,
        'Continue: if context is enough, emit sparse_intent_v0 JSON.',
      ].join('\n'),
    },
  ]
}

function longHistory(): SessionMessage[] {
  return [
    ...pairRound(OLD_EVIDENCE),
    ...pairRound(OLD_EVIDENCE),
    { role: 'user', content: `ACK card_id=s2:s0001:structure ${OLD_EVIDENCE}` },
    { role: 'user', content: `ACK card_id=s2:s0002:structure ${RECENT_ACK}` },
    ...pairRound(RECENT_ACK),
  ]
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('prompt compact (Distiller-owned history prune)', () => {
  it('default N is PROMPT_HISTORY_RECENT_ROUNDS from window.ts', () => {
    assert.equal(PROMPT_HISTORY_RECENT_ROUNDS, 2)
    const compactSrc = readFileSync(join(repoRoot, 'src/agent/prompt/compact.ts'), 'utf8')
    assert.match(compactSrc, /PROMPT_HISTORY_RECENT_ROUNDS/)
    assert.match(compactSrc, /from ['"]\.\.\/\.\.\/constant\/window\.ts['"]/)
  })

  it('strips old evidence from next prompt and keeps recent ACK + S0 pointers', () => {
    const messages = longHistory()
    const pruned = prunePromptHistory(messages)
    const joined = pruned.map((m) => m.content).join('\n')
    assert.equal(joined.includes(OLD_EVIDENCE), false)
    assert.equal(joined.includes(RECENT_ACK), true)

    const composed = composeSessionPrompt({
      messages,
      text: 'go',
      skeleton_text: S0_POINTER,
      state_pointers: STATE_PTR,
    })
    assert.equal(composed.includes(OLD_EVIDENCE), false)
    assert.equal(composed.includes(RECENT_ACK), true)
    assert.equal(composed.includes(S0_POINTER), true)
    assert.equal(composed.includes(STATE_PTR), true)
    assert.match(composed, /go/)
  })

  it('retains skeleton / S0 pointers even when all old messages are pruned', () => {
    const messages = longHistory()
    const composed = composeSessionPrompt({
      messages,
      text: 'decide',
      skeleton_text: S0_POINTER,
      state_pointers: STATE_PTR,
      system: 'SYS_STABLE',
      skill_text: 'SKILL_STABLE',
    })
    assert.equal(composed.includes(S0_POINTER), true)
    assert.equal(composed.includes(STATE_PTR), true)
    assert.match(composed, /SYS_STABLE/)
    assert.match(composed, /SKILL_STABLE/)
    const emptyPrune = composeSessionPrompt({
      messages: longHistory(),
      text: 'go',
      skeleton_text: S0_POINTER,
      state_pointers: STATE_PTR,
    })
    const prunedAway = prunePromptHistory(longHistory(), { recentRounds: 0 })
    assert.deepEqual(prunedAway, [])
    assert.equal(emptyPrune.includes(S0_POINTER), true)
  })

  it('does not mutate the input messages array (assembly drop ≠ store drop)', () => {
    const messages = longHistory()
    const before = messages.map((m) => m.content).join('\n')
    const pruned = prunePromptHistory(messages)
    assert.notEqual(pruned, messages)
    assert.equal(messages.map((m) => m.content).join('\n'), before)
    assert.equal(before.includes(OLD_EVIDENCE), true)
    const composed = composeSessionPrompt({ messages, text: 'go', skeleton_text: S0_POINTER })
    assert.equal(composed.includes(OLD_EVIDENCE), false)
    assert.equal(messages.map((m) => m.content).join('\n').includes(OLD_EVIDENCE), true)
  })

  it('does not touch a separate store/warrant-shaped object', () => {
    const compactSrc = readFileSync(join(repoRoot, 'src/agent/prompt/compact.ts'), 'utf8')
    assert.doesNotMatch(compactSrc, /write_warrant|writeWarrant/)
    const store = {
      warrant_payload: { full: `${OLD_EVIDENCE} ${RAW_BODY}` },
      training: [{ text: RAW_BODY }],
    }
    const messages = longHistory()
    prunePromptHistory(messages)
    composeSessionPrompt({ messages, text: 'go', skeleton_text: S0_POINTER })
    assert.equal(store.warrant_payload.full.includes(OLD_EVIDENCE), true)
    assert.equal(store.training[0]?.text, RAW_BODY)
  })

  it('source does not call pi compact / LLM compaction', () => {
    const files = [
      'src/agent/prompt/compact.ts',
      'src/agent/prompt/compose.ts',
      'src/agent/sessions/cut_brain.ts',
      'src/agent/sessions/sparse_intent.ts',
      'src/agent/sessions/open_session.ts',
    ]
    for (const rel of files) {
      const src = stripComments(readFileSync(join(repoRoot, rel), 'utf8'))
      assert.doesNotMatch(src, /session\.compact/)
      assert.doesNotMatch(src, /\.compact\s*\(/)
    }
  })

  it('recent ACK/masked rounds stay masked; compose does not reintroduce planted raw bodies', () => {
    const storeOnly = {
      read_segment: {
        segment_id: 's0009',
        focus: 'full',
        text: RAW_BODY.repeat(8),
      },
    }
    const messages: SessionMessage[] = [
      ...pairRound(OLD_EVIDENCE),
      ...pairRound(OLD_EVIDENCE),
      {
        role: 'user',
        content: 'ACK card_id=s2:s0009:structure',
      },
      {
        role: 'user',
        content: 'read_segment s0009 text_chars=12 head="LINE"',
      },
    ]
    const pruned = prunePromptHistory(messages)
    for (const msg of pruned) {
      assert.equal(isAckOrMaskedRoundMessage(msg), true)
      assert.equal(msg.content.includes(RAW_BODY), false)
    }
    const composed = composeSessionPrompt({
      messages,
      text: 'next',
      skeleton_text: S0_POINTER,
    })
    assert.equal(composed.includes(RAW_BODY), false)
    assert.match(composed, /ACK card_id=s2:s0009:structure/)
    assert.match(composed, /read_segment s0009/)
    assert.equal(storeOnly.read_segment.text.includes(RAW_BODY), true)
  })

  it('is exported from prompt/index.ts', () => {
    const indexSrc = readFileSync(join(repoRoot, 'src/agent/prompt/index.ts'), 'utf8')
    assert.match(indexSrc, /prunePromptHistory/)
    assert.match(indexSrc, /compact\.ts/)
  })
})
