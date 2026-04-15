import type { ContentBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { getUserContext } from 'src/context.js'
import { queryModelWithoutStreaming } from 'src/services/api/claude.js'
import { getEmptyToolPermissionContext } from 'src/Tool.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { prependUserContext } from 'src/utils/api.js'
import {
  createUserMessage,
  normalizeMessagesForAPI,
} from 'src/utils/messages.js'
import type { ModelName } from 'src/utils/model/model.js'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

type GeneratedAgent = {
  identifier: string
  whenToUse: string
  systemPrompt: string
}

const JSON_REPAIR_SUFFIXES = [
  '}',
  '"}',
  ']}',
  '"]}',
  '}}',
  '"}}',
  ']}}',
  '"]}}',
  '"]}]}',
  '}]}',
]

const AGENT_CREATION_SYSTEM_PROMPT = `You are an elite AI agent architect specializing in crafting high-performance agent configurations. Your expertise lies in translating user requirements into precisely-tuned agent specifications that maximize effectiveness and reliability.

**Important Context**: You may have access to project-specific instructions from CLAUDE.md files and other context that may include coding standards, project structure, and custom requirements. Consider this context when creating agents to ensure they align with the project's established patterns and practices.

When a user describes what they want an agent to do, you will:

1. **Extract Core Intent**: Identify the fundamental purpose, key responsibilities, and success criteria for the agent. Look for both explicit requirements and implicit needs. Consider any project-specific context from CLAUDE.md files. For agents that are meant to review code, you should assume that the user is asking to review recently written code and not the whole codebase, unless the user has explicitly instructed you otherwise.

2. **Design Expert Persona**: Create a compelling expert identity that embodies deep domain knowledge relevant to the task. The persona should inspire confidence and guide the agent's decision-making approach.

3. **Architect Comprehensive Instructions**: Develop a system prompt that:
   - Establishes clear behavioral boundaries and operational parameters
   - Provides specific methodologies and best practices for task execution
   - Anticipates edge cases and provides guidance for handling them
   - Incorporates any specific requirements or preferences mentioned by the user
   - Defines output format expectations when relevant
   - Aligns with project-specific coding standards and patterns from CLAUDE.md

4. **Optimize for Performance**: Include:
   - Decision-making frameworks appropriate to the domain
   - Quality control mechanisms and self-verification steps
   - Efficient workflow patterns
   - Clear escalation or fallback strategies

5. **Create Identifier**: Design a concise, descriptive identifier that:
   - Uses lowercase letters, numbers, and hyphens only
   - Is typically 2-4 words joined by hyphens
   - Clearly indicates the agent's primary function
   - Is memorable and easy to type
   - Avoids generic terms like "helper" or "assistant"

6 **Example agent descriptions**:
  - in the 'whenToUse' field of the JSON object, you should include examples of when this agent should be used.
  - examples should be of the form:
    - <example>
      Context: The user is creating a test-runner agent that should be called after a logical chunk of code is written.
      user: "Please write a function that checks if a number is prime"
      assistant: "Here is the relevant function: "
      <function call omitted for brevity only for this example>
      <commentary>
      Since a significant piece of code was written, use the ${AGENT_TOOL_NAME} tool to launch the test-runner agent to run the tests.
      </commentary>
      assistant: "Now let me use the test-runner agent to run the tests"
    </example>
    - <example>
      Context: User is creating an agent for Claude Code product questions.
      user: "How do I configure Claude Code hooks?"
      assistant: "I'm going to use the ${AGENT_TOOL_NAME} tool to launch the claude-code-guide agent to answer the question"
      <commentary>
      Since the user is asking how to use Claude Code, use the claude-code-guide agent.
      </commentary>
    </example>
  - If the user mentioned or implied that the agent should be used proactively, you should include examples of this.
- NOTE: Ensure that in the examples, you are making the assistant use the Agent tool and not simply respond directly to the task.

Your output must be a valid JSON object with exactly these fields:
{
  "identifier": "A unique, descriptive identifier using lowercase letters, numbers, and hyphens (e.g., 'test-runner', 'api-docs-writer', 'code-formatter')",
  "whenToUse": "A precise, actionable description starting with 'Use this agent when...' that clearly defines the triggering conditions and use cases. Ensure you include examples as described above.",
  "systemPrompt": "The complete system prompt that will govern the agent's behavior, written in second person ('You are...', 'You will...') and structured for maximum clarity and effectiveness"
}

Key principles for your system prompts:
- Be specific rather than generic - avoid vague instructions
- Include concrete examples when they would clarify behavior
- Balance comprehensiveness with clarity - every instruction should add value
- Ensure the agent has enough context to handle variations of the core task
- Make the agent proactive in seeking clarification when needed
- Build in quality assurance and self-correction mechanisms

Remember: The agents you create should be autonomous experts capable of handling their designated tasks with minimal additional guidance. Your system prompts are their complete operational manual.
`

// Agent memory instructions to include in the system prompt when memory is mentioned or relevant
const AGENT_MEMORY_INSTRUCTIONS = `

7. **Agent Memory Instructions**: If the user mentions "memory", "remember", "learn", "persist", or similar concepts, OR if the agent would benefit from building up knowledge across conversations (e.g., code reviewers learning patterns, architects learning codebase structure, etc.), include domain-specific memory update instructions in the systemPrompt.

   Add a section like this to the systemPrompt, tailored to the agent's specific domain:

   "**Update your agent memory** as you discover [domain-specific items]. This builds up institutional knowledge across conversations. Write concise notes about what you found and where.

   Examples of what to record:
   - [domain-specific item 1]
   - [domain-specific item 2]
   - [domain-specific item 3]"

   Examples of domain-specific memory instructions:
   - For a code-reviewer: "Update your agent memory as you discover code patterns, style conventions, common issues, and architectural decisions in this codebase."
   - For a test-runner: "Update your agent memory as you discover test patterns, common failure modes, flaky tests, and testing best practices."
   - For an architect: "Update your agent memory as you discover codepaths, library locations, key architectural decisions, and component relationships."
   - For a documentation writer: "Update your agent memory as you discover documentation patterns, API structures, and terminology conventions."

   The memory instructions should be specific to what the agent would naturally learn while performing its core tasks.
`

function extractFirstJSONObject(text: string): string | null {
  let start = -1
  let depth = 0
  let inString = false
  let isEscaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!ch) continue

    if (start === -1) {
      if (ch === '{') {
        start = i
        depth = 1
      }
      continue
    }

    if (inString) {
      if (isEscaped) {
        isEscaped = false
      } else if (ch === '\\') {
        isEscaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{') {
      depth++
      continue
    }

    if (ch === '}') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  return start === -1 ? null : text.slice(start)
}

function escapeControlCharactersInJsonStrings(raw: string): string {
  let out = ''
  let inString = false
  let isEscaped = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (!ch) continue

    if (inString) {
      if (isEscaped) {
        out += ch
        isEscaped = false
        continue
      }

      if (ch === '\\') {
        out += ch
        isEscaped = true
        continue
      }

      if (ch === '"') {
        out += ch
        inString = false
        continue
      }

      switch (ch) {
        case '\n':
          out += '\\n'
          continue
        case '\r':
          out += '\\r'
          continue
        case '\t':
          out += '\\t'
          continue
        case '\b':
          out += '\\b'
          continue
        case '\f':
          out += '\\f'
          continue
        default: {
          const code = ch.charCodeAt(0)
          if (code <= 0x1f) {
            out += `\\u${code.toString(16).padStart(4, '0')}`
            continue
          }
          out += ch
          continue
        }
      }
    }

    if (ch === '"') {
      inString = true
    }
    out += ch
  }

  return out
}

function repairPossiblyTruncatedObjectJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? raw
      : null
  } catch {
    for (const suffix of JSON_REPAIR_SUFFIXES) {
      try {
        const repaired = raw + suffix
        const parsed = JSON.parse(repaired)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return repaired
        }
      } catch {}
    }
    return null
  }
}

function tryParseGeneratedAgentObject(raw: string): GeneratedAgent | null {
  try {
    const parsed = jsonParse(raw) as Partial<GeneratedAgent>
    if (
      typeof parsed?.identifier === 'string' &&
      typeof parsed.whenToUse === 'string' &&
      typeof parsed.systemPrompt === 'string'
    ) {
      return {
        identifier: parsed.identifier.trim(),
        whenToUse: parsed.whenToUse,
        systemPrompt: parsed.systemPrompt,
      }
    }
  } catch {}

  return null
}

function decodeLooseJsonString(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\\//g, '/')
}

function tryExtractGeneratedAgentFields(raw: string): GeneratedAgent | null {
  const identifierMatch = raw.match(
    /"identifier"\s*:\s*"([\s\S]*?)"\s*,\s*"whenToUse"\s*:/,
  )
  const whenToUseMatch = raw.match(
    /"whenToUse"\s*:\s*"([\s\S]*?)"\s*,\s*"systemPrompt"\s*:/,
  )
  const systemPromptMatch = raw.match(
    /"systemPrompt"\s*:\s*"([\s\S]*?)"\s*}\s*$/,
  )

  const identifier = identifierMatch?.[1]?.trim()
  const whenToUse = whenToUseMatch?.[1]
  const systemPrompt = systemPromptMatch?.[1]

  if (!identifier || whenToUse === undefined || systemPrompt === undefined) {
    return null
  }

  return {
    identifier: decodeLooseJsonString(identifier).trim(),
    whenToUse: decodeLooseJsonString(whenToUse),
    systemPrompt: decodeLooseJsonString(systemPrompt),
  }
}

export function parseGeneratedAgentResponse(responseText: string): GeneratedAgent {
  const trimmed = responseText.trim()
  const extracted = extractFirstJSONObject(trimmed)
  const candidates = new Set<string>()

  if (trimmed) {
    candidates.add(trimmed)
  }
  if (extracted) {
    candidates.add(extracted.trim())
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  if (fenced) {
    candidates.add(fenced)
  }

  for (const candidate of candidates) {
    if (!candidate) continue

    const escapedControls = escapeControlCharactersInJsonStrings(candidate)
    const repairedVariants = [
      candidate,
      escapedControls,
      repairPossiblyTruncatedObjectJson(candidate),
      repairPossiblyTruncatedObjectJson(escapedControls),
    ].filter((value): value is string => Boolean(value))

    for (const variant of repairedVariants) {
      const parsed = tryParseGeneratedAgentObject(variant)
      if (parsed) {
        return parsed
      }
    }

    const looseParsed =
      tryExtractGeneratedAgentFields(candidate) ??
      tryExtractGeneratedAgentFields(escapedControls)
    if (looseParsed) {
      return looseParsed
    }
  }

  throw new Error(
    'Failed to parse generated agent. The model returned malformed JSON.',
  )
}

export async function generateAgent(
  userPrompt: string,
  model: ModelName,
  existingIdentifiers: string[],
  abortSignal: AbortSignal,
): Promise<GeneratedAgent> {
  const existingList =
    existingIdentifiers.length > 0
      ? `\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existingIdentifiers.join(', ')}`
      : ''

  const prompt = `Create an agent configuration based on this request: "${userPrompt}".${existingList}
  Return ONLY the JSON object, no other text.
  IMPORTANT: escape every newline inside JSON string values as \\n, and escape inner double quotes.`

  const userMessage = createUserMessage({ content: prompt })

  // Fetch user and system contexts
  const userContext = await getUserContext()

  // Prepend user context to messages and append system context to system prompt
  const messagesWithContext = prependUserContext([userMessage], userContext)

  // Include memory instructions when the feature is enabled
  const systemPrompt = isAutoMemoryEnabled()
    ? AGENT_CREATION_SYSTEM_PROMPT + AGENT_MEMORY_INSTRUCTIONS
    : AGENT_CREATION_SYSTEM_PROMPT

  const response = await queryModelWithoutStreaming({
    messages: normalizeMessagesForAPI(messagesWithContext),
    systemPrompt: asSystemPrompt([systemPrompt]),
    thinkingConfig: { type: 'disabled' as const },
    tools: [],
    signal: abortSignal,
    options: {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model,
      toolChoice: undefined,
      agents: [],
      isNonInteractiveSession: false,
      hasAppendSystemPrompt: false,
      querySource: 'agent_creation',
      mcpTools: [],
    },
  })

  const textBlocks = response.message.content.filter(
    (block): block is ContentBlock & { type: 'text' } => block.type === 'text',
  )
  const responseText = textBlocks.map(block => block.text).join('\n')

  const parsed = parseGeneratedAgentResponse(responseText)

  if (!parsed.identifier || !parsed.whenToUse || !parsed.systemPrompt) {
    throw new Error('Invalid agent configuration generated')
  }

  logEvent('tengu_agent_definition_generated', {
    agent_identifier:
      parsed.identifier as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return {
    identifier: parsed.identifier,
    whenToUse: parsed.whenToUse,
    systemPrompt: parsed.systemPrompt,
  }
}
