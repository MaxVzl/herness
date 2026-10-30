import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunResult } from '../exec.ts'
import type { Effects } from './effects.ts'

export type EnvCheck = { label: string; status: 'OK' | 'KO'; detail: string }

/**
 * Contrôles d'environnement avant une mission. herdr est requis par herness : son absence est un KO.
 * Pour un KO, `detail` contient la commande `!` que l'utilisateur doit lancer.
 */
export async function checkEnv(repo: string, e: Effects): Promise<EnvCheck[]> {
  const sh = async (cmd: string, args: string[]): Promise<RunResult> => {
    try {
      return await e.run(cmd, args, { reject: false })
    } catch (err) {
      return { stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 127 }
    }
  }
  const out: EnvCheck[] = []
  const ok = (label: string, detail: string) => out.push({ label, status: 'OK', detail })
  const ko = (label: string, detail: string) => out.push({ label, status: 'KO', detail })

  // 1. Identité git : jamais devinée, toujours configurée par l'utilisateur.
  let id: { name: string; email: string } | null = null
  try {
    id = await e.git.identity(repo)
  } catch {
    id = null
  }
  if (id && id.name) ok('git', `identité : ${id.name} <${id.email}>`)
  else ko('git', `aucune identité git complète — l'utilisateur lance : ! git config --global user.name "Prénom Nom" && git config --global user.email "adresse@exemple.fr"`)

  // 2. Docker (base de test).
  if ((await sh('docker', ['info'])).exitCode === 0) ok('docker', 'accessible')
  else if ((await sh('sg', ['docker', '-c', 'docker info'])).exitCode === 0) ok('docker', "accessible via 'sg docker'")
  else ko('docker', "inaccessible — l'utilisateur lance : ! sudo systemctl start docker (ou, hors du groupe docker : ! sudo usermod -aG docker $USER puis rouvre sa session)")

  // 3. Cursor CLI (implémenteurs).
  const cursor = await sh('cursor-agent', ['status'])
  if (/Logged in/.test(cursor.stdout + cursor.stderr) && !/Not logged in/i.test(cursor.stdout + cursor.stderr)) ok('cursor', 'connecté')
  else if (cursor.exitCode === 127) ko('cursor', "cursor-agent introuvable — l'utilisateur lance : ! curl https://cursor.com/install -fsS | bash")
  else ko('cursor', "non connecté — l'utilisateur lance : ! cursor-agent login")

  // 4. herdr : requis.
  if ((await sh('herdr', ['workspace', 'list'])).exitCode === 0) ok('herdr', 'serveur joignable')
  else ko('herdr', "serveur injoignable — l'utilisateur lance herdr puis relance la mission depuis un panneau herdr : ! herdr")

  // 5. GitHub CLI (PR).
  if ((await sh('gh', ['auth', 'status'])).exitCode === 0) ok('gh', 'authentifié')
  else ko('gh', "gh absent ou non authentifié — l'utilisateur lance : ! gh auth login")

  // 6. node / pnpm, si le projet en dépend.
  const hasPackage = await access(join(repo, 'package.json')).then(() => true, () => false)
  if (hasPackage) {
    const node = await sh('node', ['--version'])
    const pnpm = await sh('pnpm', ['--version'])
    if (node.exitCode === 0 && pnpm.exitCode === 0) ok('node', `node ${node.stdout.trim()}, pnpm ${pnpm.stdout.trim()}`)
    else ko('node', "node ou pnpm introuvable dans le PATH — l'utilisateur lance : ! corepack enable pnpm")
  }
  return out
}
