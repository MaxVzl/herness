import { expect, test } from 'vitest'
import { prepareTuiEnv } from '../../src/ui/tui-env.ts'

test('prepareTuiEnv coupe les invites de git et ssh', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/bin' }
  prepareTuiEnv(env)
  expect(env).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' })
})

test('prepareTuiEnv garde la commande ssh choisie et y ajoute BatchMode une seule fois', () => {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '1', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/cle' }
  prepareTuiEnv(env)
  expect(env).toEqual({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/cle -oBatchMode=yes' })
  prepareTuiEnv(env)
  expect(env.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/cle -oBatchMode=yes')
})
