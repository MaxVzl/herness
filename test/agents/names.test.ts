import { expect, test } from 'vitest'
import {
  agentName,
  diagnosticName,
  globalFixerName,
  globalReviewerName,
  implName,
  orchestratorName,
  preflightFixerName,
  reviewerName,
  strongName,
} from '../../src/agents/names.ts'
import { missionDir } from '../../src/paths.ts'

const HERDR_AGENT = /^[a-z][a-z0-9_-]{0,31}$/

test("every generated agent name follows the herdr rule, whatever the generation", () => {
  const ids = ['1234567890', 'gh42', '20261029-1', 'T-1', '9'.repeat(40)]
  for (const id of ids) {
    const names = [orchestratorName(id)]
    for (const n of [1, 12]) names.push(implName(id, n), strongName(id, n), reviewerName(id, n))
    for (const g of [1, 2, 3]) {
      names.push(globalReviewerName(id, g))
      for (const r of [1, 3]) names.push(globalFixerName(id, g, r), diagnosticName(id, g, r), preflightFixerName(id, g, r))
    }
    for (const name of names) expect(name, name).toMatch(HERDR_AGENT)
    expect(new Set(names).size, `unique names for ${id}`).toBe(names.length)
  }
})

test('generation > 1: suffix -g<n>, never a dot', () => {
  expect(globalReviewerName('gh42', 1)).toBe('rggh42')
  expect(globalReviewerName('gh42', 2)).toBe('rggh42-g2')
  expect(globalFixerName('gh42', 3, 1)).toBe('cggh42-1-g3')
})

test('agentName: lowercase, forbidden characters become dashes, a letter first, 32 characters with a hash suffix', () => {
  expect(agentName('cT-1.2')).toBe('ct-1-2')
  expect(agentName('1abc')).toMatch(HERDR_AGENT)
  const a = agentName('c' + '1'.repeat(40) + '-t1')
  const b = agentName('c' + '1'.repeat(40) + '-t2')
  expect(a).toMatch(HERDR_AGENT)
  expect(b).toMatch(HERDR_AGENT)
  expect(a).not.toBe(b)
})

test('missionDir refuses an invalid mission id (including path traversal)', () => {
  for (const bad of ['../x', 'a/b', '', '-x', 'a'.repeat(65), 'a b', '.']) expect(() => missionDir(bad), bad).toThrow()
  for (const good of ['1234567890', 'gh42', '20261029-1', 'T-1']) expect(() => missionDir(good)).not.toThrow()
})
