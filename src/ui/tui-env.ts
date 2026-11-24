/**
 * Environment for ink interfaces (`herness cockpit`, `herness tasks`): no command launched from here (git, ssh)
 * may open a credential prompt in the terminal ink is drawing. Call this before any action.
 */
export function prepareTuiEnv(env: NodeJS.ProcessEnv = process.env): void {
  env.GIT_TERMINAL_PROMPT = '0'
  const ssh = env.GIT_SSH_COMMAND?.trim()
  if (!ssh) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes'
  else if (!/BatchMode/i.test(ssh)) env.GIT_SSH_COMMAND = `${ssh} -oBatchMode=yes`
}
