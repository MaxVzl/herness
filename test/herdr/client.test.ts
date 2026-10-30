import { beforeEach, expect, test, vi } from 'vitest'

const replies: Record<string, { stdout: string; stderr: string; exitCode: number }> = {}
vi.mock('../../src/exec.ts', () => ({
  run: async (_cmd: string, args: string[]) => replies[args.slice(0, 2).join(' ')] ?? { stdout: '', stderr: '', exitCode: 0 },
}))

const { Herdr } = await import('../../src/herdr/client.ts')

const status = (s: string) => ({ stdout: JSON.stringify({ result: { agent: { agent_status: s } } }), stderr: '', exitCode: 0 })

beforeEach(() => {
  for (const k of Object.keys(replies)) delete replies[k]
})

test.each(['working', 'starting', 'quelque-chose'])("agentPrompt/agentWait : un état « %s » n'est jamais pris pour une fin (timeout, état brut journalisé)", async (raw) => {
  const logs: string[] = []
  const h = new Herdr((m) => logs.push(m))
  replies['agent prompt'] = status(raw)
  replies['agent wait'] = status(raw)
  expect(await h.agentPrompt('a1', 'x', { wait: true, timeoutMs: 1 })).toBe('timeout')
  expect(await h.agentWait('a1', { until: ['idle', 'done', 'blocked'], timeoutMs: 1 })).toBe('timeout')
  expect(logs).toHaveLength(2)
  expect(logs.every((l) => l.includes(raw) && l.includes('a1'))).toBe(true)
})

test('agentPrompt/agentWait : sans état lisible ni agent, timeout', async () => {
  const logs: string[] = []
  const h = new Herdr((m) => logs.push(m))
  replies['agent prompt'] = { stdout: '{}', stderr: '', exitCode: 0 }
  replies['agent get'] = { stdout: '', stderr: JSON.stringify({ error: { code: 'agent_not_found', message: 'x' } }), exitCode: 1 }
  expect(await h.agentPrompt('a1', 'x', { wait: true })).toBe('timeout')
  expect(logs[0]).toContain('inconnu')
})

test('agentPrompt/agentWait : idle, done et blocked sont rendus tels quels', async () => {
  const h = new Herdr(() => {})
  for (const s of ['idle', 'done', 'blocked']) {
    replies['agent prompt'] = status(s)
    replies['agent wait'] = status(s)
    expect(await h.agentPrompt('a1', 'x', { wait: true })).toBe(s)
    expect(await h.agentWait('a1', { until: ['idle'], timeoutMs: 1 })).toBe(s)
  }
})
