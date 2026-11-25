import { expect, test } from 'vitest'
import { prepareTuiEnv } from '../../src/ui/tui-env.ts'

test('prepareTuiEnv disables git and ssh prompts', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/bin' }
  prepareTuiEnv(env)
  expect(env).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' })
})

test('prepareTuiEnv keeps the chosen ssh command and adds BatchMode once', () => {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '1', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/cle' }
  prepareTuiEnv(env)
  expect(env).toEqual({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/cle -oBatchMode=yes' })
  prepareTuiEnv(env)
  expect(env.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/cle -oBatchMode=yes')
})
