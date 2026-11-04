import { randomBytes, timingSafeEqual } from 'node:crypto'

export function newToken(): string {
  return randomBytes(32).toString('hex')
}

/** Comparaison du jeton en temps constant. Longueurs différentes : refus immédiat. */
export function tokensEqual(presented: string, token: string): boolean {
  const left = Buffer.from(presented)
  const right = Buffer.from(token)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  const value = found?.[1]
  if (Array.isArray(value)) return value[0]
  return value
}

function cookieValue(raw: string | undefined, name: string): string | undefined {
  if (!raw) return undefined
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

export function checkRequest(
  req: { method: string; headers: Record<string, string | string[] | undefined> },
  token: string,
  port: number,
): { ok: true } | { ok: false; status: 401 | 403 } {
  const presented = cookieValue(header(req.headers, 'cookie'), 'herness_web')
  if (presented === undefined || !tokensEqual(presented, token)) return { ok: false, status: 401 }
  const host = header(req.headers, 'host')
  const allowedHost = host === `localhost:${port}` || host === `127.0.0.1:${port}`
  if (!allowedHost) return { ok: false, status: 403 }
  if (req.method === 'POST') {
    const origin = header(req.headers, 'origin')
    const allowedOrigin = origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`
    if (!allowedOrigin) return { ok: false, status: 403 }
  }
  return { ok: true }
}
