import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunResult } from '../exec.ts'
import type { Effects } from './effects.ts'

export type EnvCheck = { label: string; status: 'OK' | 'KO'; detail: string }

/**
 * Environment checks before a mission. herdr is required by herness: its absence is a KO.
 * For a KO, `detail` contains the `!` command the user must run.
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

  // 1. Git identity: never guessed, always configured by the user.
  let id: { name: string; email: string } | null = null
  try {
    id = await e.git.identity(repo)
  } catch {
    id = null
  }
  if (id && id.name) ok('git', `identity: ${id.name} <${id.email}>`)
  else ko('git', `no complete git identity — the user runs: ! git config --global user.name "First Last" && git config --global user.email "name@example.com"`)

  // 2. Docker (test database).
  if ((await sh('docker', ['info'])).exitCode === 0) ok('docker', 'reachable')
  else if ((await sh('sg', ['docker', '-c', 'docker info'])).exitCode === 0) ok('docker', "reachable via 'sg docker'")
  else ko('docker', "unreachable — the user runs: ! sudo systemctl start docker (or, if not in the docker group: ! sudo usermod -aG docker $USER then reopen the session)")

  // 3. Cursor CLI (implementers).
  const cursor = await sh('cursor-agent', ['status'])
  if (/Logged in/.test(cursor.stdout + cursor.stderr) && !/Not logged in/i.test(cursor.stdout + cursor.stderr)) ok('cursor', 'signed in')
  else if (cursor.exitCode === 127) ko('cursor', 'cursor-agent not found — the user runs: ! curl https://cursor.com/install -fsS | bash')
  else ko('cursor', 'not signed in — the user runs: ! cursor-agent login')

  // 4. herdr: required.
  if ((await sh('herdr', ['workspace', 'list'])).exitCode === 0) ok('herdr', 'server reachable')
  else ko('herdr', 'server unreachable — the user starts herdr, then restarts the mission from a herdr pane: ! herdr')

  // 5. GitHub CLI (PR).
  if ((await sh('gh', ['auth', 'status'])).exitCode === 0) ok('gh', 'authenticated')
  else ko('gh', 'gh missing or not authenticated — the user runs: ! gh auth login')

  // 6. node / pnpm, when the project depends on them.
  const hasPackage = await access(join(repo, 'package.json')).then(() => true, () => false)
  if (hasPackage) {
    const node = await sh('node', ['--version'])
    const pnpm = await sh('pnpm', ['--version'])
    if (node.exitCode === 0 && pnpm.exitCode === 0) ok('node', `node ${node.stdout.trim()}, pnpm ${pnpm.stdout.trim()}`)
    else ko('node', 'node or pnpm not found on PATH — the user runs: ! corepack enable pnpm')
  }
  return out
}
