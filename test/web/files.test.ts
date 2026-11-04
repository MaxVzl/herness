import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { missionDir, missionsRoot } from '../../src/paths.ts'
import { newToken } from '../../src/web/auth.ts'
import { startWebServer } from '../../src/web/server.ts'

const MO = 1024 * 1024
const TRUNCATED = '… (début tronqué)\n'

let home: string
let previousHome: string | undefined
const servers: { close(): Promise<void> }[] = []

beforeEach(async () => {
  previousHome = process.env.HERNESS_HOME
  home = await mkdtemp(join(tmpdir(), 'herness-files-'))
  process.env.HERNESS_HOME = home
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  if (previousHome === undefined) delete process.env.HERNESS_HOME
  else process.env.HERNESS_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

async function boot(): Promise<{ get(path: string): Promise<Response> }> {
  const token = newToken()
  const server = await startWebServer({ port: 0, token })
  servers.push(server)
  return {
    get: (path) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: { cookie: `herness_web=${token}` },
      signal: AbortSignal.timeout(2000),
    }),
  }
}

function fichier(chemin: string): string {
  return `/api/missions/m1/fichier?chemin=${encodeURIComponent(chemin)}`
}

test('taches/1/revue.md existant est renvoyé tel quel', async () => {
  const dir = join(missionDir('m1'), 'taches', '1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'revue.md'), 'revue de la tâche\n')
  const api = await boot()
  const res = await api.get(fichier('taches/1/revue.md'))
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(await res.text()).toBe('revue de la tâche\n')
})

test('un chemin hors du dossier de mission répond 400 sans être lu', async () => {
  await mkdir(join(missionDir('m1'), 'taches', '1'), { recursive: true })
  const outside = join(missionsRoot(), 'x')
  await new Promise<void>((resolve, reject) => {
    execFile('mkfifo', [outside], (err) => (err ? reject(err) : resolve()))
  })
  const escaped = join(home, 'etc', 'passwd')
  await mkdir(join(home, 'etc'), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    execFile('mkfifo', [escaped], (err) => (err ? reject(err) : resolve()))
  })
  const api = await boot()
  for (const chemin of ['../../etc/passwd', '/etc/passwd', 'taches/../../x']) {
    const res = await api.get(fichier(chemin))
    expect(res.status, chemin).toBe(400)
    expect(await res.text(), chemin).toBe('')
  }
})

test('un fichier absent répond 404', async () => {
  await mkdir(missionDir('m1'), { recursive: true })
  const api = await boot()
  const res = await api.get(fichier('taches/1/revue.md'))
  expect(res.status).toBe(404)
  expect(await res.text()).toBe('')
})

test('un fichier de 3 Mo renvoie les 2 derniers Mo précédés de la ligne de troncature', async () => {
  const dir = join(missionDir('m1'), 'logs')
  await mkdir(dir, { recursive: true })
  const payload = Buffer.alloc(3 * MO, 0x61)
  payload.write('FIN', payload.length - 3)
  await writeFile(join(dir, 'agent.log'), payload)
  const api = await boot()
  const res = await api.get(fichier('logs/agent.log'))
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text.startsWith(TRUNCATED)).toBe(true)
  expect(Buffer.byteLength(text)).toBe(2 * MO + Buffer.byteLength(TRUNCATED))
  expect(text.slice(TRUNCATED.length)).toBe(payload.subarray(payload.length - 2 * MO).toString('utf8'))
})

test('un lien symbolique sortant du dossier de mission répond 400 sans être lu', async () => {
  const dir = join(missionDir('m1'), 'taches', '1')
  await mkdir(dir, { recursive: true })
  const outside = join(home, 'secret')
  await new Promise<void>((resolve, reject) => {
    execFile('mkfifo', [outside], (err) => (err ? reject(err) : resolve()))
  })
  await symlink(outside, join(dir, 'lien'))
  const api = await boot()
  const res = await api.get(fichier('taches/1/lien'))
  expect(res.status).toBe(400)
  expect(await res.text()).toBe('')
})
