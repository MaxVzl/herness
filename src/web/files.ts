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
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch (err) {
    plain(res, ioStatus(err), '')
    return
  }
  let real: string
  try {
    real = await realpath(resolved)
  } catch (err) {
    plain(res, ioStatus(err), '')
    return
  }
  if (!real.startsWith(realRoot + sep)) {
    plain(res, 400, '')
    return
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(real)
  } catch (err) {
    plain(res, ioStatus(err), '')
    return
  }
  if (!info.isFile()) {
    plain(res, 404, '')
    return
  }
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(real, 'r')
  } catch (err) {
    plain(res, ioStatus(err), '')
    return
  }
  try {
    if (info.size <= MAX_BYTES) {
      const buf = Buffer.alloc(info.size)
      if (info.size === 0) {
        plain(res, 200, buf)
        return
      }
      const { bytesRead } = await file.read(buf, 0, info.size, 0)
      plain(res, 200, buf.subarray(0, bytesRead))
      return
    }
    const tail = Buffer.alloc(MAX_BYTES)
    const { bytesRead } = await file.read(tail, 0, MAX_BYTES, info.size - MAX_BYTES)
    plain(res, 200, Buffer.concat([Buffer.from(TRUNCATED), utf8Tail(tail.subarray(0, bytesRead))]))
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

function ioStatus(err: unknown): 404 | 500 {
  return code(err) === 'ENOENT' ? 404 : 500
}

/** Ote les octets de continuation UTF-8 laissés en tête par une coupure au milieu d'un caractère. */
function utf8Tail(buf: Buffer): Buffer {
  let start = 0
  while (start < buf.length) {
    const byte = buf[start]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    start++
  }
  return start === 0 ? buf : buf.subarray(start)
}

function plain(res: ServerResponse, status: number, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}
