import { expect, test, vi } from 'vitest'

const calls: string[][] = []
vi.mock('../../src/exec.ts', () => ({
  run: async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args])
    return { stdout: '', stderr: '', exitCode: 0 }
  },
}))

test('Herdr.workspaceClose ferme un seul espace, jamais avec --group', async () => {
  const { Herdr } = await import('../../src/herdr/client.ts')
  await new Herdr().workspaceClose('w7')
  expect(calls).toEqual([['herdr', 'workspace', 'close', 'w7']])
})
