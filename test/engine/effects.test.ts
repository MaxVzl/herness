import { expect, test } from 'vitest'
import { realEffects } from '../../src/engine/effects.ts'

test('realEffects forwards the log to herdr and the agents; default is console.error', () => {
  const log = (_m: string): void => {}
  const e = realEffects({ log })
  expect((e.herdr as unknown as { log: unknown }).log).toBe(log)
  expect((e.agents as unknown as { log: unknown }).log).toBe(log)
  expect((realEffects().herdr as unknown as { log: unknown }).log).not.toBe(log)
})
