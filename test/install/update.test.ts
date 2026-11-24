import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { newState, saveState, type MissionState } from '../../src/mission/state.ts'
import { hernessCommand, installDir, installedBin, installedVersion, restartInstalled, runningMissions, runsInstalled, shellLine, staleNotice, update, type UpdateDeps } from '../../src/update.ts'

let home: string
const saved = { ...process.env }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herness-update-'))
  process.env.HERNESS_HOME = home
})
afterEach(async () => {
  process.env = { ...saved }
  await rm(home, { recursive: true, force: true })
})

function deps(answer = true): UpdateDeps & { calls: string[]; lines: string[] } {
  const calls: string[] = []
  const lines: string[] = []
  return {
    calls,
    lines,
    install: async (args) => {
      calls.push(`install ${args.join(' ')}`.trim())
    },
    restart: async (id) => {
      calls.push(`restart ${id}`)
    },
    isTTY: true,
    confirm: async (q) => {
      calls.push(`confirm ${q}`)
      return answer
    },
    out: (l) => lines.push(l),
  }
}

const mission = (id: string, step: MissionState['step']): MissionState => ({ ...newState({ id, source: { kind: 'text', ref: id }, project: 'demo', repoPath: '/depot' }), step })

test('installe la dernière version ou celle demandée', async () => {
  const d = deps()
  await update({}, d, async () => [])
  await update({ version: '0.4.0' }, d, async () => [])
  expect(d.calls).toEqual(['install', 'install --version 0.4.0'])
  expect(d.lines).toEqual([])
})

test('propose de redémarrer les missions en cours, avec le nouveau code', async () => {
  const d = deps(true)
  await update({}, d, async () => [mission('a1', 'tasks'), mission('b2', 'spec')])
  expect(d.lines[0]).toBe("Missions en cours, encore sur l'ancien code : a1, b2")
  expect(d.calls).toEqual(['install', 'confirm Les redémarrer sur la nouvelle version ?', 'restart a1', 'restart b2'])
})

test('refusé : rien de redémarré, la commande est rappelée', async () => {
  const d = deps(false)
  await update({}, d, async () => [mission('a1', 'tasks')])
  expect(d.calls).not.toContain('restart a1')
  expect(d.lines.at(-1)).toBe('Plus tard : herness resume <id> --restart')
})

test('hors terminal : ne demande rien, liste les commandes', async () => {
  const d = { ...deps(true), isTTY: false }
  await update({}, d, async () => [mission('a1', 'tasks')])
  expect(d.calls).toEqual(['install'])
  expect(d.lines).toContain('  herness resume a1 --restart')
})

test('un redémarrage en échec n’empêche pas les autres, puis erreur récapitulative', async () => {
  const d = deps(true)
  d.restart = async (id) => {
    d.calls.push(`restart ${id}`)
    if (id === 'a1') throw new Error('herdr absent')
  }
  await expect(update({}, d, async () => [mission('a1', 'tasks'), mission('b2', 'tasks')]))
    .rejects.toThrow('redémarrage à relancer à la main : herness resume a1 --restart')
  expect(d.calls).toContain('restart b2')
  expect(d.lines).toContain('a1 : redémarrage échoué : herdr absent')
})

test('installation en échec : aucune mission touchée', async () => {
  const d = deps(true)
  d.install = async () => {
    throw new Error('téléchargement impossible')
  }
  let listed = false
  await expect(update({}, d, async () => {
    listed = true
    return []
  })).rejects.toThrow('téléchargement impossible')
  expect(listed).toBe(false)
})

test('missions en cours : ni PR ouverte, ni fermée, ni bloquée', async () => {
  for (const [id, step] of [['a1', 'tasks'], ['b2', 'pr-open'], ['c3', 'closed'], ['d4', 'blocked'], ['e5', 'preflight']] as const) {
    await saveState(mission(id, step))
  }
  expect((await runningMissions()).map((s) => s.id)).toEqual(['a1', 'e5'])
})

test('lanceur installé : HERNESS_INSTALL_DIR, sinon XDG_DATA_HOME, sinon ~/.local/share', () => {
  expect(installedBin({ HERNESS_INSTALL_DIR: '/opt/h', HOME: '/home/x' })).toBe('/opt/h/current/bin/herness')
  expect(installedBin({ XDG_DATA_HOME: '/d', HOME: '/home/x' })).toBe('/d/herness/current/bin/herness')
  expect(installedBin({ HOME: '/home/x' })).toBe('/home/x/.local/share/herness/current/bin/herness')
})

test('restartInstalled lance le binaire installé avec resume <id> --restart', async () => {
  const calls: unknown[] = []
  const exec = async (cmd: string, args: string[], opts: { stdio: string }) => {
    calls.push([cmd, args, opts])
  }
  await restartInstalled('m1', exec, { HERNESS_INSTALL_DIR: '/opt/h', HOME: '/home/x' })
  expect(calls).toEqual([['/opt/h/current/bin/herness', ['resume', 'm1', '--restart'], { stdio: 'inherit' }]])
})

test('la CLI accepte --version sur mise-a-jour sans le confondre avec --version de herness', async () => {
  const r = await execa('node', ['bin/herness.js', 'update', '--help'], { reject: false, stdin: 'ignore' })
  expect(r.stdout).toContain('--version <x.y.z>')
})

test('installDir suit HERNESS_INSTALL_DIR, puis XDG_DATA_HOME, puis HOME', () => {
  expect(installDir({ HERNESS_INSTALL_DIR: '/opt/h', HOME: '/home/x' })).toBe('/opt/h')
  expect(installDir({ XDG_DATA_HOME: '/d', HOME: '/home/x' })).toBe('/d/herness')
  expect(installDir({ HOME: '/home/x' })).toBe('/home/x/.local/share/herness')
})

test('runsInstalled : vrai pour une racine sous versions/, aussi atteinte par le lien current', async () => {
  const data = await mkdtemp(join(tmpdir(), 'herness-install-'))
  try {
    const env = { HERNESS_INSTALL_DIR: data, HOME: '/home/x' }
    await mkdir(join(data, 'versions', '0.8.0'), { recursive: true })
    await symlink('versions/0.8.0', join(data, 'current'))
    expect(runsInstalled(env, join(data, 'versions', '0.8.0'))).toBe(true)
    expect(runsInstalled(env, join(data, 'current'))).toBe(true)
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})

test('runsInstalled : faux pour un dossier de sources ou sans dossier versions', async () => {
  const data = await mkdtemp(join(tmpdir(), 'herness-install-'))
  try {
    const env = { HERNESS_INSTALL_DIR: data, HOME: '/home/x' }
    expect(runsInstalled(env, process.cwd())).toBe(false)
    expect(runsInstalled(env, data)).toBe(false)
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})

test('hernessCommand : lanceur installé si la version tourne depuis versions/ et que current/bin/herness existe', async () => {
  const data = await mkdtemp(join(tmpdir(), 'herness-install-'))
  try {
    const env = { HERNESS_INSTALL_DIR: data, HOME: '/home/x' }
    await mkdir(join(data, 'versions', '0.8.0', 'bin'), { recursive: true })
    await writeFile(join(data, 'versions', '0.8.0', 'bin', 'herness'), '')
    await symlink('versions/0.8.0', join(data, 'current'))
    const root = join(data, 'versions', '0.6.0')
    await mkdir(root, { recursive: true })
    expect(hernessCommand(env, root)).toEqual({ cmd: join(data, 'current', 'bin', 'herness'), args: [] })
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})

test('hernessCommand : node + bin/herness.js hors installation ou si le lanceur installé manque', async () => {
  const data = await mkdtemp(join(tmpdir(), 'herness-install-'))
  try {
    const env = { HERNESS_INSTALL_DIR: data, HOME: '/home/x' }
    expect(hernessCommand(env, process.cwd())).toEqual({ cmd: 'node', args: [join(process.cwd(), 'bin', 'herness.js')] })
    const root = join(data, 'versions', '0.6.0')
    await mkdir(root, { recursive: true })
    expect(hernessCommand(env, root)).toEqual({ cmd: 'node', args: [join(root, 'bin', 'herness.js')] })
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})

test('shellLine cite les chemins et laisse node nu', () => {
  expect(shellLine({ cmd: 'node', args: ["/a b/it's/herness.js"] }, 'engine x')).toBe(`node '/a b/it'\\''s/herness.js' engine x`)
  expect(shellLine({ cmd: '/d/current/bin/herness', args: [] }, 'cockpit')).toBe(`'/d/current/bin/herness' cockpit`)
})

test('installedVersion lit current/package.json, null sinon', async () => {
  const data = await mkdtemp(join(tmpdir(), 'herness-install-'))
  try {
    const env = { HERNESS_INSTALL_DIR: data, HOME: '/home/x' }
    expect(installedVersion(env)).toBeNull()
    await mkdir(join(data, 'versions', '0.8.0'), { recursive: true })
    await symlink('versions/0.8.0', join(data, 'current'))
    const pkg = join(data, 'current', 'package.json')
    await writeFile(pkg, '{"version":"0.8.0"}')
    expect(installedVersion(env)).toBe('0.8.0')
    await writeFile(pkg, '{')
    expect(installedVersion(env)).toBeNull()
    await writeFile(pkg, '{"name":"x"}')
    expect(installedVersion(env)).toBeNull()
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})

test('staleNotice : message seulement si la version installée diffère et que le processus tourne depuis une installation', async () => {
  const data = await mkdtemp(join(tmpdir(), 'herness-install-'))
  try {
    const env = { HERNESS_INSTALL_DIR: data, HOME: '/home/x' }
    const root = join(data, 'versions', '0.6.0')
    await mkdir(join(data, 'versions', '0.8.0'), { recursive: true })
    await mkdir(root, { recursive: true })
    await symlink('versions/0.8.0', join(data, 'current'))
    const pkg = join(data, 'current', 'package.json')
    await writeFile(pkg, '{"version":"0.8.0"}')
    expect(staleNotice('0.6.0', env, root)).toBe('herness 0.8.0 installé, ce cockpit tourne en 0.6.0 : quitte-le et relance herness')
    expect(staleNotice('0.8.0', env, root)).toBeNull()
    expect(staleNotice('0.6.0', env, process.cwd())).toBeNull()
    await rm(pkg)
    expect(staleNotice('0.6.0', env, root)).toBeNull()
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})
