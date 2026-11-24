import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { newState, saveState, type MissionState } from '../../src/mission/state.ts'
import { missionDir } from '../../src/paths.ts'
import { hernessCommand, installDir, installedBin, installedVersion, isPreEnglish, restartInstalled, runningMissions, runsInstalled, shellLine, staleNotice, update, type UpdateDeps } from '../../src/update.ts'

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

const listed = (running: MissionState[], legacy: MissionState[] = []) => async () => ({ running, legacy })

test('installs the latest version or the one requested', async () => {
  const d = deps()
  await update({}, d, listed([]))
  await update({ version: '1.2.3' }, d, listed([]))
  expect(d.calls).toEqual(['install', 'install --version 1.2.3'])
  expect(d.lines).toEqual([])
})

test('offers to restart running missions on the new code', async () => {
  const d = deps(true)
  await update({}, d, listed([mission('a1', 'tasks'), mission('b2', 'spec')]))
  expect(d.lines[0]).toBe('Missions still running on the old code: a1, b2')
  expect(d.calls).toEqual(['install', 'confirm Restart them on the new version?', 'restart a1', 'restart b2'])
})

test('refused: nothing restarted, the command is repeated', async () => {
  const d = deps(false)
  await update({}, d, listed([mission('a1', 'tasks')]))
  expect(d.calls).not.toContain('restart a1')
  expect(d.lines.at(-1)).toBe('Later: herness resume <id> --restart')
})

test('outside a terminal: asks nothing, lists the commands', async () => {
  const d = { ...deps(true), isTTY: false }
  await update({}, d, listed([mission('a1', 'tasks')]))
  expect(d.calls).toEqual(['install'])
  expect(d.lines).toContain('  herness resume a1 --restart')
})

test('one failed restart does not stop the others, then a summary error', async () => {
  const d = deps(true)
  d.restart = async (id) => {
    d.calls.push(`restart ${id}`)
    if (id === 'a1') throw new Error('herdr missing')
  }
  await expect(update({}, d, listed([mission('a1', 'tasks'), mission('b2', 'tasks')])))
    .rejects.toThrow('restart these by hand: herness resume a1 --restart')
  expect(d.calls).toContain('restart b2')
  expect(d.lines).toContain('a1: restart failed: herdr missing')
})

test('failed install: no mission is touched', async () => {
  const d = deps(true)
  d.install = async () => {
    throw new Error('download failed')
  }
  let listed = false
  await expect(update({}, d, async () => {
    listed = true
    return { running: [], legacy: [] }
  })).rejects.toThrow('download failed')
  expect(listed).toBe(false)
})

test('running missions: not a PR open, not closed, not blocked', async () => {
  for (const [id, step] of [['a1', 'tasks'], ['b2', 'pr-open'], ['c3', 'closed'], ['d4', 'blocked'], ['e5', 'preflight']] as const) {
    await saveState(mission(id, step))
  }
  const found = await runningMissions()
  expect(found.running.map((s) => s.id)).toEqual(['a1', 'e5'])
  expect(found.legacy.map((s) => s.id)).toEqual([])
})

test('isPreEnglish', () => {
  expect(isPreEnglish('0.8.1')).toBe(true)
  expect(isPreEnglish('v0.8.0')).toBe(true)
  expect(isPreEnglish('0.9.0')).toBe(false)
  expect(isPreEnglish('1.0.0')).toBe(false)
})

test('update --version 0.8.1 offers no restart', async () => {
  const d = deps()
  let listedCalled = false
  await update({ version: '0.8.1' }, d, async () => {
    listedCalled = true
    return { running: [mission('a1', 'tasks')], legacy: [] }
  })
  expect(listedCalled).toBe(false)
  expect(d.calls).toEqual(['install --version 0.8.1'])
  expect(d.lines).toEqual([
    'herness 0.8.1 cannot read missions created by newer versions.',
    'Missions it started can be restarted with: herness reprendre <id> --redemarrer',
  ])
})

test('update lists legacy missions apart and restarts only the others', async () => {
  const d = deps(true)
  const legacy = mission('A', 'tasks')
  delete legacy.format
  const running = mission('B', 'tasks')
  await update({}, d, listed([running], [legacy]))
  expect(d.lines).toContain(
    'mission A was created by herness 0.8 or earlier and is still running: finish it with that version (herness update --version 0.8.1) or close it (herness close A)',
  )
  expect(d.calls).toEqual(['install', 'confirm Restart them on the new version?', 'restart B'])
  expect(d.calls).not.toContain('restart A')
})

test('runningMissions separates unfinished legacy missions', async () => {
  await saveState(mission('cur', 'tasks'))
  await saveState(mission('done', 'closed'))
  await saveState(mission('wait', 'blocked'))
  for (const [id, step] of [['old-run', 'tasks'], ['old-block', 'blocked'], ['old-done', 'pr-open']] as const) {
    const s = mission(id, step)
    await saveState(s)
    const file = join(missionDir(id), 'state.json')
    const raw = JSON.parse(await readFile(file, 'utf8')) as { format?: number }
    delete raw.format
    await writeFile(file, JSON.stringify(raw))
  }
  const found = await runningMissions()
  expect(found.running.map((s) => s.id)).toEqual(['cur'])
  expect(found.legacy.map((s) => s.id)).toEqual(['old-block', 'old-run'])
})

test('installed launcher: HERNESS_INSTALL_DIR, else XDG_DATA_HOME, else ~/.local/share', () => {
  expect(installedBin({ HERNESS_INSTALL_DIR: '/opt/h', HOME: '/home/x' })).toBe('/opt/h/current/bin/herness')
  expect(installedBin({ XDG_DATA_HOME: '/d', HOME: '/home/x' })).toBe('/d/herness/current/bin/herness')
  expect(installedBin({ HOME: '/home/x' })).toBe('/home/x/.local/share/herness/current/bin/herness')
})

test('restartInstalled launches the installed binary with resume <id> --restart', async () => {
  const calls: unknown[] = []
  const exec = async (cmd: string, args: string[], opts: { stdio: string }) => {
    calls.push([cmd, args, opts])
  }
  await restartInstalled('m1', exec, { HERNESS_INSTALL_DIR: '/opt/h', HOME: '/home/x' })
  expect(calls).toEqual([['/opt/h/current/bin/herness', ['resume', 'm1', '--restart'], { stdio: 'inherit' }]])
})

test('the CLI accepts --version on update without confusing it with herness --version', async () => {
  const r = await execa('node', ['bin/herness.js', 'update', '--help'], { reject: false, stdin: 'ignore' })
  expect(r.stdout).toContain('--version <x.y.z>')
})

test('installDir follows HERNESS_INSTALL_DIR, then XDG_DATA_HOME, then HOME', () => {
  expect(installDir({ HERNESS_INSTALL_DIR: '/opt/h', HOME: '/home/x' })).toBe('/opt/h')
  expect(installDir({ XDG_DATA_HOME: '/d', HOME: '/home/x' })).toBe('/d/herness')
  expect(installDir({ HOME: '/home/x' })).toBe('/home/x/.local/share/herness')
})

test('runsInstalled: true for a root under versions/, also reached through the current link', async () => {
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

test('runsInstalled: false for a source folder or without a versions folder', async () => {
  const data = await mkdtemp(join(tmpdir(), 'herness-install-'))
  try {
    const env = { HERNESS_INSTALL_DIR: data, HOME: '/home/x' }
    expect(runsInstalled(env, process.cwd())).toBe(false)
    expect(runsInstalled(env, data)).toBe(false)
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})

test('hernessCommand: installed launcher when the version runs from versions/ and current/bin/herness exists', async () => {
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

test('hernessCommand: node + bin/herness.js outside an install or when the installed launcher is missing', async () => {
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

test('shellLine quotes paths and leaves node bare', () => {
  expect(shellLine({ cmd: 'node', args: ["/a b/it's/herness.js"] }, 'engine x')).toBe(`node '/a b/it'\\''s/herness.js' engine x`)
  expect(shellLine({ cmd: '/d/current/bin/herness', args: [] }, 'cockpit')).toBe(`'/d/current/bin/herness' cockpit`)
})

test('installedVersion reads current/package.json, null otherwise', async () => {
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

test('staleNotice: a message only when the installed version differs and the process runs from an install', async () => {
  const data = await mkdtemp(join(tmpdir(), 'herness-install-'))
  try {
    const env = { HERNESS_INSTALL_DIR: data, HOME: '/home/x' }
    const root = join(data, 'versions', '0.6.0')
    await mkdir(join(data, 'versions', '0.8.0'), { recursive: true })
    await mkdir(root, { recursive: true })
    await symlink('versions/0.8.0', join(data, 'current'))
    const pkg = join(data, 'current', 'package.json')
    await writeFile(pkg, '{"version":"0.8.0"}')
    expect(staleNotice('0.6.0', env, root)).toBe('herness 0.8.0 is installed, this cockpit is running 0.6.0: quit it and start herness again')
    expect(staleNotice('0.8.0', env, root)).toBeNull()
    expect(staleNotice('0.6.0', env, process.cwd())).toBeNull()
    await rm(pkg)
    expect(staleNotice('0.6.0', env, root)).toBeNull()
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})
