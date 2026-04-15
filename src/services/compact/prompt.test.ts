import { describe, expect, test } from 'bun:test'

import {
  formatCompactSummary,
  looksLikeCompactPromptEcho,
} from './prompt.js'

describe('compact prompt echo guards', () => {
  test('formats a normal XML compact summary', () => {
    const raw = `<analysis>
Internal scratchpad that should never survive.
</analysis>

<summary>
1. Primary Request and Intent:
   Fix compaction behavior.

2. Key Technical Concepts:
   - plan mode
</summary>`

    expect(formatCompactSummary(raw)).toBe(
      `Summary:
1. Primary Request and Intent:
   Fix compaction behavior.

2. Key Technical Concepts:
   - plan mode`,
    )
  })

  test('detects compact prompt echo responses', () => {
    const promptEcho = `1. Respond with TEXT ONLY - no tool calls of any kind
2. The response must be in XML format with <analysis> and <summary> blocks
3. Must include 9 distinct sections in the summary
4. Tool calls will be rejected and waste the only turn
5. All context is already available in the conversation above`

    expect(looksLikeCompactPromptEcho(promptEcho)).toBe(true)
  })

  test('replaces prompt echo output with a safe fallback summary', () => {
    const promptEcho = `1. Respond with TEXT ONLY - no tool calls of any kind
2. The response must be in XML format with <analysis> and <summary> blocks
3. Must include 9 distinct sections in the summary
4. The conversation so far is a set of instructions for how to respond to a future task
5. Tool calls will be rejected and waste the only turn
6. All context is already available in the conversation above`

    expect(formatCompactSummary(promptEcho)).toContain(
      'Summary unavailable: the compaction model returned formatting instructions',
    )
  })

  test('treats paraphrased compact meta output as prompt echo', () => {
    const paraphrasedEcho = `The user's requirements are:
1. Respond with TEXT ONLY
2. Do NOT call any tools
3. Follow a specific format with <analysis> and <summary> blocks

The previous portion contained only system instructions and tool definitions, with no actual conversation content to analyze.

This is a template generation scenario rather than an actual development work scenario with files to analyze.`

    expect(looksLikeCompactPromptEcho(paraphrasedEcho)).toBe(true)
    expect(formatCompactSummary(paraphrasedEcho)).toContain(
      'Summary unavailable: the compaction model returned formatting instructions',
    )
  })

  test('does not treat sectioned plain text summaries as prompt echo', () => {
    const plainTextSummary = `1. Primary Request and Intent:
   Investigate why compaction breaks plan mode.

2. Key Technical Concepts:
   - compaction
   - prompt echo`

    expect(looksLikeCompactPromptEcho(plainTextSummary)).toBe(false)
    expect(formatCompactSummary(plainTextSummary)).toBe(plainTextSummary)
  })
})
