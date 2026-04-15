import { expect, test } from 'bun:test'

import { parseGeneratedAgentResponse } from './generateAgent.js'

test('parseGeneratedAgentResponse parses valid JSON', () => {
  const parsed = parseGeneratedAgentResponse(`{
    "identifier": "site-builder",
    "whenToUse": "Use this agent when building or redesigning websites.",
    "systemPrompt": "You are a frontend engineer focused on websites."
  }`)

  expect(parsed.identifier).toBe('site-builder')
  expect(parsed.whenToUse).toContain('building or redesigning websites')
  expect(parsed.systemPrompt).toContain('frontend engineer')
})

test('parseGeneratedAgentResponse repairs raw newlines and quotes inside JSON strings', () => {
  const parsed = parseGeneratedAgentResponse(`{
    "identifier": "site-builder",
    "whenToUse": "Use this agent when creating landing pages and websites.
Example: if the user says "create a SaaS homepage", use this agent.",
    "systemPrompt": "You are a website specialist.
Preserve existing design systems when present."
  }`)

  expect(parsed.identifier).toBe('site-builder')
  expect(parsed.whenToUse).toContain('create a SaaS homepage')
  expect(parsed.systemPrompt).toContain('website specialist')
  expect(parsed.systemPrompt).toContain('design systems')
})

test('parseGeneratedAgentResponse extracts JSON from fenced output', () => {
  const parsed = parseGeneratedAgentResponse(`Here is the agent:

\`\`\`json
{
  "identifier": "site-builder",
  "whenToUse": "Use this agent when the user needs a website.",
  "systemPrompt": "You are a frontend developer who builds websites."
}
\`\`\`
`)

  expect(parsed.identifier).toBe('site-builder')
  expect(parsed.whenToUse).toContain('needs a website')
})
