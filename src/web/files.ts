import { open, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve, sep } from 'node:path'
import { missionDir } from '../paths.ts'
import type { Route } from './server.ts'

const MAX_BYTES = 2 * 1024 * 1024
const TRUNCATED = '… (début tronqué)\n'

/** Lecture d'un fichier du dossier de mission. Un chemin qui en sort est refusé avant tout accès disque. */
export function fileRoutes(): Route[] {
  return [{
    method: 'GET',
    pattern: /^\/api\/missions\/([^/]+)\/fichier$/,
    handle: (req, res, match) => serveMissionFile(req, res, match),
  }]
}

async function serveMissionFile(req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray): Promise<void> {
  const id = decode(match[1])
  if (!id) {
    plain(res, 400, '')
    return
  }
  let root: string
  try {
    root = missionDir(id)
  } catch {
    plain(res, 400, '')
    return
  }
  const chemin = new URL(req.url ?? '/', 'http://localhost').searchParams.get('chemin')
  if (chemin === null) {
    plain(res, 400, '')
    return
  }
  const resolved = resolve(root, chemin)
  const prefix = root + sep
  if (!resolved.startsWith(prefix)) {
    plain(res, 400, '')
    return
  }
  let real: string
  try {
    real = await realpath(resolved)
  } catch (err) {
    plain(res, code(err) === 'ENOENT' ? 404 : 400, '')
    return
  }
  if (!real.startsWith(prefix)) {
    plain(res, 400, '')
    return
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(real)
  } catch (err) {
    plain(res, code(err) === 'ENOENT' ? 404 : 400, '')
    return
  }
  if (!info.isFile()) {
    plain(res, 404, '')
    return
  }
  const file = await open(real, 'r')
  try {
    if (info.size <= MAX_BYTES) {
      const buf = Buffer.alloc(info.size)
      if (info.size > 0) await file.read(buf, 0, info.size, 0)
      plain(res, 200, buf)
      return
    }
    const tail = Buffer.alloc(MAX_BYTES)
    await file.read(tail, 0, MAX_BYTES, info.size - MAX_BYTES)
    plain(res, 200, Buffer.concat([Buffer.from(TRUNCATED), tail]))
  } finally {
    await file.close()
  }
}

function decode(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

function code(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') return err.code
  return undefined
}

function plain(res: ServerResponse, status: number, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}
