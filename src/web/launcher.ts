import { closeSync, mkdirSync, openSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Herdr } from '../herdr/client.ts'
import { hernessHome } from '../paths.ts'
import { realActionDeps } from '../ui/actions.ts'
import { PrCache } from '../ui/pr-cache.ts'
import { VERSION } from '../version.ts'
import { newToken } from './auth.ts'
import { Hub } from './hub.ts'
import { startWebServer } from './server.ts'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'herness.js')
const WAIT_STEP_MS = 100
const START_STEPS = 100
const STOP_STEPS = 50

export interface WebInfo {
  pid: number
  port: number
  version: string
  token: string
  startedAt: string
}

export interface SpawnOptions {
  detached?: boolean
  stdio?: 'ignore' | readonly ['ignore', number, number]
}

export interface Spawned {
  unref(): void
  once(event: 'error', listener: (err: Error) => void): void
}

export type Spawner = (command: string, args: readonly string[], options?: SpawnOptions) => Spawned

export interface LauncherDeps {
  spawn: Spawner
  isAlive(pid: number): boolean
  kill(pid: number, sig: NodeJS.Signals): void
  sleep(ms: number): Promise<void>
  out(line: string): void
  env: NodeJS.ProcessEnv
}

export function webInfoPath(): string {
  return join(hernessHome(), 'web.json')
}

function webLogPath(): string {
  return join(hernessHome(), 'logs', 'web.log')
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return typeof err === 'object' && err !== null && 'code' in err && err.code === 'EPERM'
  }
}

function isWebInfo(value: unknown): value is WebInfo {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<WebInfo>
  return typeof v.pid === 'number' && typeof v.port === 'number'
    && typeof v.version === 'string' && typeof v.token === 'string' && typeof v.startedAt === 'string'
}

/** `null` si le fichier manque, est illisible, ou si le pid ne tourne plus. */
export async function readWebInfo(isAlive: (pid: number) => boolean = processAlive): Promise<WebInfo | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(webInfoPath(), 'utf8'))
    if (!isWebInfo(parsed) || !isAlive(parsed.pid)) return null
    return parsed
  } catch {
    return null
  }
}

export async function writeWebInfo(i: WebInfo): Promise<void> {
  const path = webInfoPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(i), { mode: 0o600 })
  await chmod(path, 0o600)
}

export async function removeWebInfo(): Promise<void> {
  await rm(webInfoPath(), { force: true })
}

export function webUrl(i: WebInfo): string {
  return `http://localhost:${i.port}/?cle=${i.token}`
}

function show(info: WebInfo, o: { sansNavigateur?: boolean }, d: LauncherDeps): number {
  if (info.version !== VERSION) {
    d.out(`serveur d'une autre version (${info.version}) : herness web --redemarrer`)
  }
  const url = webUrl(info)
  if (o.sansNavigateur) {
    d.out(url)
    return 0
  }
  const child = d.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  child.once('error', () => {})
  child.unref()
  return 0
}

async function stop(d: LauncherDeps, quiet: boolean): Promise<number> {
  const info = await readWebInfo(d.isAlive)
  if (!info) {
    if (!quiet) d.out('aucun serveur herness web')
    return 0
  }
  d.kill(info.pid, 'SIGTERM')
  for (let i = 0; i < STOP_STEPS && d.isAlive(info.pid); i++) await d.sleep(WAIT_STEP_MS)
  await removeWebInfo()
  return 0
}

async function waitForStart(d: LauncherDeps): Promise<WebInfo | null> {
  for (let i = 0; i < START_STEPS; i++) {
    const info = await readWebInfo(d.isAlive)
    if (info) return info
    await d.sleep(WAIT_STEP_MS)
  }
  return null
}

async function launch(o: { sansNavigateur?: boolean; port: number }, d: LauncherDeps): Promise<number> {
  const log = webLogPath()
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'a')
  try {
    const child = d.spawn(process.execPath, [
      BIN, 'web', '--premier-plan', '--sans-navigateur', '--port', String(o.port),
    ], { detached: true, stdio: ['ignore', fd, fd] })
    child.once('error', () => {})
    child.unref()
  } finally {
    closeSync(fd)
  }
  const info = await waitForStart(d)
  if (!info) {
    d.out(`le serveur n'a pas démarré : voir ${log}`)
    return 1
  }
  return show(info, o, d)
}

export async function webCommand(
  o: { arreter?: boolean; redemarrer?: boolean; premierPlan?: boolean; sansNavigateur?: boolean; port: number },
  d: LauncherDeps,
): Promise<number> {
  if (o.arreter && !o.redemarrer) return stop(d, false)
  if (d.env.HERDR_ENV !== '1') {
    d.out('lance herness web depuis un panneau herdr')
    return 1
  }
  if (o.redemarrer) await stop(d, true)
  if (o.premierPlan) {
    await runForeground(o.port)
    return 0
  }
  const existing = await readWebInfo(d.isAlive)
  if (existing) return show(existing, o, d)
  return launch(o, d)
}

/** Serveur au premier plan : journal sur la sortie standard, `web.json` retiré sur SIGINT ou SIGTERM. */
export async function runForeground(port: number): Promise<void> {
  const existing = await readWebInfo()
  if (existing) {
    throw new Error(`un serveur herness web tourne déjà (pid ${existing.pid}) : herness web --redemarrer`)
  }
  const token = newToken()
  const log = (line: string) => console.log(line)
  const herdr = new Herdr(log)
  const hub = new Hub({ herdr, prCache: new PrCache(), now: () => new Date() })
  let server: Awaited<ReturnType<typeof startWebServer>> | undefined
  let wrote = false
  try {
    await hub.start()
    server = await startWebServer({
      port,
      token,
      hub,
      actions: { hub, deps: (cwd) => realActionDeps(cwd, log), herdr },
    })
    const info: WebInfo = {
      pid: process.pid,
      port: server.port,
      version: VERSION,
      token,
      startedAt: new Date().toISOString(),
    }
    await writeWebInfo(info)
    wrote = true
    console.log(`herness web écoute sur 127.0.0.1:${server.port}`)
    await new Promise<void>((resolve) => {
      const end = () => resolve()
      process.once('SIGINT', end)
      process.once('SIGTERM', end)
    })
  } finally {
    try {
      await hub.stop()
      if (server) await server.close()
    } finally {
      if (wrote) {
        const current = await readWebInfo(() => true)
        if (current?.pid === process.pid) await removeWebInfo()
      }
    }
  }
}
