import { expect, test } from 'vitest'
import { realEffects } from '../../src/engine/effects.ts'

test('realEffects transmet le journal à herdr et aux agents ; défaut console.error', () => {
  const log = (_m: string): void => {}
  const e = realEffects({ log })
  expect((e.herdr as unknown as { log: unknown }).log).toBe(log)
  expect((e.agents as unknown as { log: unknown }).log).toBe(log)
  expect((realEffects().herdr as unknown as { log: unknown }).log).not.toBe(log)
})
