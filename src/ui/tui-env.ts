/**
 * Environnement des interfaces ink (`herness cockpit`, `herness tasks`) : aucune commande lancée d'ici (git, ssh) ne
 * doit ouvrir d'invite d'identifiants dans le terminal qu'ink dessine. À appeler avant toute action.
 */
export function prepareTuiEnv(env: NodeJS.ProcessEnv = process.env): void {
  env.GIT_TERMINAL_PROMPT = '0'
  const ssh = env.GIT_SSH_COMMAND?.trim()
  if (!ssh) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes'
  else if (!/BatchMode/i.test(ssh)) env.GIT_SSH_COMMAND = `${ssh} -oBatchMode=yes`
}
