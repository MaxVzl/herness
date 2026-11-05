import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { newState, saveState, type MissionState } from '../../src/mission/state.ts'
import { installedBin, runningMissions, update, type UpdateDeps } from '../../src/update.ts'

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
  expect(d.lines.at(-1)).toBe('Plus tard : herness reprendre <id> --redemarrer')
})

test('hors terminal : ne demande rien, liste les commandes', async () => {
  const d = { ...deps(true), isTTY: false }
  await update({}, d, async () => [mission('a1', 'tasks')])
  expect(d.calls).toEqual(['install'])
  expect(d.lines).toContain('  herness reprendre a1 --redemarrer')
})

test('un redémarrage en échec n’empêche pas les autres, puis erreur récapitulative', async () => {
  const d = deps(true)
  d.restart = async (id) => {
    d.calls.push(`restart ${id}`)
    if (id === 'a1') throw new Error('herdr absent')
  }
  await expect(update({}, d, async () => [mission('a1', 'tasks'), mission('b2', 'tasks')]))
    .rejects.toThrow('redémarrage à relancer à la main : herness reprendre a1 --redemarrer')
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
  for (const [id, step] of [['a1', 'tasks'], ['b2', 'pr-ouverte'], ['c3', 'fermée'], ['d4', 'bloquée'], ['e5', 'preflight']] as const) {
    await saveState(mission(id, step))
  }
  expect((await runningMissions()).map((s) => s.id)).toEqual(['a1', 'e5'])
})

test('lanceur installé : HERNESS_INSTALL_DIR, sinon XDG_DATA_HOME, sinon ~/.local/share', () => {
  expect(installedBin({ HERNESS_INSTALL_DIR: '/opt/h', HOME: '/home/x' })).toBe('/opt/h/current/bin/herness')
  expect(installedBin({ XDG_DATA_HOME: '/d', HOME: '/home/x' })).toBe('/d/herness/current/bin/herness')
  expect(installedBin({ HOME: '/home/x' })).toBe('/home/x/.local/share/herness/current/bin/herness')
})

test('la CLI accepte --version sur mise-a-jour sans le confondre avec --version de herness', async () => {
  const r = await execa('node', ['bin/herness.js', 'mise-a-jour', '--help'], { reject: false, stdin: 'ignore' })
  expect(r.stdout).toContain('--version <x.y.z>')
})
