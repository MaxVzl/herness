import { spawn } from 'node:child_process'
import { readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { VERSION } from '../../src/version.ts'
import {
  readWebInfo,
  removeWebInfo,
  runForeground,
  webCommand,
  webInfoPath,
  webUrl,
  writeWebInfo,
  type LauncherDeps,
  type WebInfo,
} from '../../src/web/launcher.ts'

let home: string
let previousHome: string | undefined
let previousHerdr: string | undefined

beforeEach(async () => {
  previousHome = process.env.HERNESS_HOME
  previousHerdr = process.env.HERDR_ENV
  home = await mkdtemp(join(tmpdir(), 'herness-web-'))
  process.env.HERNESS_HOME = home
  delete process.env.HERDR_ENV
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HERNESS_HOME
  else process.env.HERNESS_HOME = previousHome
  if (previousHerdr === undefined) delete process.env.HERDR_ENV
  else process.env.HERDR_ENV = previousHerdr
  await rm(home, { recursive: true, force: true })
})

const info: WebInfo = {
  pid: 4242,
  port: 4747,
  version: VERSION,
  token: 'jeton-test',
  startedAt: '2026-11-04T12:00:00.000Z',
}

function herdrEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.HERDR_ENV
  return env
}

interface SpawnCall {
  cmd: string
  args: readonly string[]
  opts?: { detached?: boolean; stdio?: 'ignore' | readonly ['ignore', number, number] }
}

function harness(over: Partial<LauncherDeps> = {}): {
  calls: SpawnCall[]
  lines: string[]
  killed: { pid: number; sig: NodeJS.Signals }[]
  sleeps: number[]
  deps: LauncherDeps
} {
  const calls: SpawnCall[] = []
  const lines: string[] = []
  const killed: { pid: number; sig: NodeJS.Signals }[] = []
  const sleeps: number[] = []
  const dead = new Set<number>()
  const deps: LauncherDeps = {
    spawn(cmd, args, opts) {
      const call = { cmd, args, ...(opts !== undefined ? { opts } : {}) }
      calls.push(call)
      return { unref() {}, once() {} }
    },
    isAlive: (pid) => !dead.has(pid),
    kill(pid, sig) {
      killed.push({ pid, sig })
      dead.add(pid)
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    out: (line) => lines.push(line),
    env: { ...herdrEnv(), HERDR_ENV: '1' },
    ...over,
  }
  return { calls, lines, killed, sleeps, deps }
}

test('writeWebInfo crée web.json en 0600, readWebInfo le relit, pid mort ou illisible donne null', async () => {
  expect(webInfoPath()).toBe(join(home, 'web.json'))
  await expect(readWebInfo()).resolves.toBeNull()

  await writeWebInfo(info)
  const mode = (await stat(webInfoPath())).mode & 0o777
  expect(mode).toBe(0o600)
  await expect(readWebInfo(() => true)).resolves.toEqual(info)
  await expect(readWebInfo(() => false)).resolves.toBeNull()

  await writeFile(webInfoPath(), '{', { mode: 0o600 })
  await expect(readWebInfo(() => true)).resolves.toBeNull()

  await removeWebInfo()
  await expect(readWebInfo(() => true)).resolves.toBeNull()
})

test('hors herdr, sans --arreter : code 1, message, aucun spawn', async () => {
  const { calls, lines, deps } = harness({ env: herdrEnv() })
  const code = await webCommand({ port: 4747 }, deps)
  expect(code).toBe(1)
  expect(lines).toEqual(['lance herness web depuis un panneau herdr'])
  expect(calls).toEqual([])
})

test('aucun serveur : démarre détaché, attend web.json, ouvre le navigateur', async () => {
  const { calls, lines, deps } = harness({
    spawn(cmd, args, opts) {
      const call = { cmd, args, ...(opts !== undefined ? { opts } : {}) }
      calls.push(call)
      if (cmd === process.execPath && opts && Array.isArray(opts.stdio)) {
        expect(readlinkSync(`/proc/self/fd/${opts.stdio[1]}`)).toBe(join(home, 'logs', 'web.log'))
        expect(opts.stdio[2]).toBe(opts.stdio[1])
        writeFileSync(webInfoPath(), JSON.stringify({ ...info, pid: 5150 }))
      }
      return { unref() {}, once() {} }
    },
  })
  const code = await webCommand({ port: 4747 }, deps)
  expect(code).toBe(0)
  expect(lines).toEqual([])
  expect(calls).toHaveLength(2)
  expect(calls[0]).toMatchObject({
    cmd: process.execPath,
    args: [expect.stringMatching(/\/bin\/herness\.js$/), 'web', '--premier-plan', '--sans-navigateur', '--port', '4747'],
    opts: { detached: true, stdio: ['ignore', expect.any(Number), expect.any(Number)] },
  })
  expect(calls[1]).toMatchObject({ cmd: 'xdg-open', args: [webUrl({ ...info, pid: 5150 })] })
  expect(webUrl({ ...info, pid: 5150 })).toBe('http://localhost:4747/?cle=jeton-test')
})

test('serveur déjà lancé : seulement xdg-open, et un avertissement si la version diffère', async () => {
  await writeWebInfo(info)
  const same = harness()
  expect(await webCommand({ port: 4747 }, same.deps)).toBe(0)
  expect(same.calls.map((call) => call.cmd)).toEqual(['xdg-open'])
  expect(same.calls[0]?.args).toEqual([webUrl(info)])
  expect(same.lines).toEqual([])

  await writeWebInfo({ ...info, version: '0.0.1' })
  const other = harness()
  expect(await webCommand({ port: 4747 }, other.deps)).toBe(0)
  expect(other.calls.map((call) => call.cmd)).toEqual(['xdg-open'])
  expect(other.lines).toEqual(["serveur d'une autre version (0.0.1) : herness web --redemarrer"])
})

test('--sans-navigateur affiche l’URL et n’ouvre pas le navigateur', async () => {
  await writeWebInfo(info)
  const { calls, lines, deps } = harness()
  expect(await webCommand({ port: 4747, sansNavigateur: true }, deps)).toBe(0)
  expect(calls).toEqual([])
  expect(lines).toEqual([webUrl(info)])
})

test('--arreter envoie SIGTERM, attend la fin et supprime web.json', async () => {
  await writeWebInfo(info)
  let alive = true
  const { killed, sleeps, deps } = harness({
    isAlive: () => alive,
    kill(pid, sig) {
      killed.push({ pid, sig })
      alive = false
    },
  })
  expect(await webCommand({ port: 4747, arreter: true }, deps)).toBe(0)
  expect(killed).toEqual([{ pid: 4242, sig: 'SIGTERM' }])
  expect(sleeps).toEqual([])
  await expect(stat(webInfoPath())).rejects.toThrow()
})

test('--arreter attend au plus 5 s puis supprime web.json même si le pid vit encore', async () => {
  await writeWebInfo(info)
  const { sleeps, deps } = harness({ isAlive: () => true })
  expect(await webCommand({ port: 4747, arreter: true }, deps)).toBe(0)
  expect(sleeps).toEqual(Array.from({ length: 50 }, () => 100))
  await expect(stat(webInfoPath())).rejects.toThrow()
})

test('--arreter sans serveur : message et code 0', async () => {
  const { calls, lines, killed, deps } = harness({ env: herdrEnv() })
  expect(await webCommand({ port: 4747, arreter: true }, deps)).toBe(0)
  expect(lines).toEqual(['aucun serveur herness web'])
  expect(calls).toEqual([])
  expect(killed).toEqual([])
})

test('--redemarrer arrête puis démarre', async () => {
  await writeWebInfo(info)
  const { calls, killed, deps } = harness({
    spawn(cmd, args, opts) {
      const call = { cmd, args, ...(opts !== undefined ? { opts } : {}) }
      calls.push(call)
      if (cmd === process.execPath) writeFileSync(webInfoPath(), JSON.stringify({ ...info, pid: 6000, token: 'neuf' }))
      return { unref() {}, once() {} }
    },
  })
  expect(await webCommand({ port: 4747, redemarrer: true }, deps)).toBe(0)
  expect(killed).toEqual([{ pid: 4242, sig: 'SIGTERM' }])
  expect(calls.map((call) => call.cmd)).toEqual([process.execPath, 'xdg-open'])
  expect(calls[1]?.args).toEqual(['http://localhost:4747/?cle=neuf'])
  expect(JSON.parse(readFileSync(webInfoPath(), 'utf8')).pid).toBe(6000)
})

test('runForeground refuse si un serveur tourne déjà et laisse son web.json', async () => {
  const holder = createServer((_req, res) => {
    res.end('occupe')
  })
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', () => resolve()))
  const port = (holder.address() as AddressInfo).port
  try {
    await writeWebInfo({ ...info, pid: process.pid, port })
    const before = await readFile(webInfoPath(), 'utf8')
    await expect(runForeground(port)).rejects.toThrow(/serveur herness web tourne déjà/)
    expect(await readFile(webInfoPath(), 'utf8')).toBe(before)
  } finally {
    await new Promise<void>((resolve, reject) => holder.close((err) => (err ? reject(err) : resolve())))
  }
})

test('un échec de démarrage ne supprime pas un web.json que ce processus n’a pas écrit', async () => {
  const holder = createServer((_req, res) => {
    res.end('occupe')
  })
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', () => resolve()))
  const port = (holder.address() as AddressInfo).port
  try {
    await writeWebInfo({ ...info, pid: 2_147_483_647, port })
    await expect(runForeground(port)).rejects.toThrow(/déjà utilisé/)
    expect(JSON.parse(await readFile(webInfoPath(), 'utf8')).pid).toBe(2_147_483_647)
  } finally {
    await new Promise<void>((resolve, reject) => holder.close((err) => (err ? reject(err) : resolve())))
  }
})

test('SIGTERM ferme le serveur même si un client SSE est connecté', async () => {
  const bin = fileURLToPath(new URL('../../bin/herness.js', import.meta.url))
  const child = spawn(process.execPath, [bin, 'web', '--premier-plan', '--port', '0'], {
    env: { ...process.env, HERDR_ENV: '1', HERNESS_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  try {
    const started = Date.now()
    let live: WebInfo | null = null
    while (Date.now() - started < 15_000) {
      live = await readWebInfo()
      if (live || child.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(live, stderr).not.toBeNull()
    const current = live as WebInfo
    await new Promise<void>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port: current.port,
        path: '/api/evenements',
        headers: { host: `127.0.0.1:${current.port}`, cookie: `herness_web=${current.token}` },
      }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE ${res.statusCode}`))
          res.resume()
          return
        }
        res.on('data', () => {})
        resolve()
      })
      req.on('error', reject)
      req.end()
    })
    child.kill('SIGTERM')
    const outcome = await Promise.race([
      new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code))),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
    ])
    expect(outcome, stderr).not.toBe('timeout')
    await expect(readWebInfo(() => true)).resolves.toBeNull()
  } finally {
    kill()
  }
}, 20_000)

test('web.json absent après 10 s : code 1 et le chemin du journal', async () => {
  const { calls, lines, sleeps, deps } = harness()
  expect(await webCommand({ port: 4747 }, deps)).toBe(1)
  expect(calls.map((call) => call.cmd)).toEqual([process.execPath])
  expect(lines).toEqual([`le serveur n'a pas démarré : voir ${join(home, 'logs', 'web.log')}`])
  expect(sleeps).toEqual(Array.from({ length: 100 }, () => 100))
})
