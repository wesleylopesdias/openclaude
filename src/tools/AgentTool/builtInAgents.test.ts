import { expect, test } from 'bun:test'

import {
  areExplorePlanAgentsEnabled,
  getBuiltInAgents,
} from './builtInAgents.js'

test('Explore and Plan agents are enabled by default in open/local builds', () => {
  expect(areExplorePlanAgentsEnabled()).toBe(true)
})

test('built-in agents include Explore and Plan by default', () => {
  const agentTypes = getBuiltInAgents().map(agent => agent.agentType)

  expect(agentTypes).toContain('Explore')
  expect(agentTypes).toContain('Plan')
})
