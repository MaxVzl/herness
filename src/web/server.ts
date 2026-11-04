import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { checkRequest, hostAllowed, tokensEqual } from './auth.ts'
import { actionRoutes, type WebActionDeps } from './actions.ts'
import { buildClient } from './bundle.ts'
import type { Hub } from './hub.ts'
import type { ServerEvent } from './protocol.ts'

export interface Route {
  method: 'GET' | 'POST'
  pattern: RegExp
  handle(req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray, body: unknown): Promise<void>
}

export interface WebServerOptions {
  port: number
  token: string
  routes?: Route[]
  hub?: Hub
  actions?: WebActionDeps
}

const MAX_BODY = 1024 * 1024

const PAGE = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>herness</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`

const DENIED = `<!DOCTYPE html>
<html lang="fr"><body><p>relance herness web</p></body></html>
`

interface ClientBundle {
  js: string
  css: string
}

export async function startWebServer(o: WebServerOptions): Promise<{ port: number; url: string; close(): Promise<void> }> {
  const client = await buildClient()
  const routes = [...(o.actions ? actionRoutes(o.actions) : []), ...(o.routes ?? [])]
  let port = o.port
  const server = createServer((req, res) => {
    void handle(req, res, { ...o, port, routes }, client).catch((err: unknown) => {
      const status = clientStatus(err)
      if (status === undefined) console.error(err)
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      res.writeHead(status ?? 500, {
        'content-type': 'text/plain; charset=utf-8',
        ...(status === 413 ? { connection: 'close' } : {}),
      })
      res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`port ${o.port} déjà utilisé par un autre programme (--port pour en choisir un autre)`))
        return
      }
      reject(err)
    }
    server.once('error', onError)
    server.listen(o.port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address() as AddressInfo
      port = address.port
      resolve()
    })
  })

  return {
    port,
    url: `http://localhost:${port}/?cle=${o.token}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    }),
  }
}

function clientStatus(err: unknown): 400 | 413 | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined
  const status = err.status
  if (status === 400 || status === 413) return status
  return undefined
}

function deny(res: ServerResponse, status: 401 | 403): void {
  if (status === 401) {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
    res.end(DENIED)
    return
  }
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('interdit')
}

async function handle(req: IncomingMessage, res: ServerResponse, o: WebServerOptions, client: ClientBundle): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const method = req.method ?? 'GET'

  if (method === 'GET' && url.pathname === '/' && url.searchParams.has('cle')) {
    if (!hostAllowed(req.headers, o.port)) {
      deny(res, 403)
      return
    }
    if (!tokensEqual(url.searchParams.get('cle') ?? '', o.token)) {
      deny(res, 401)
      return
    }
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': `herness_web=${o.token}; HttpOnly; SameSite=Strict; Path=/`,
    })
    res.end()
    return
  }

  const gate = checkRequest({ method, headers: req.headers }, o.token, o.port)
  if (!gate.ok) {
    deny(res, gate.status)
    return
  }

  const body = method === 'POST' ? await readJson(req) : undefined
  if (method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (method === 'GET' && url.pathname === '/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(client.js)
    return
  }
  if (method === 'GET' && url.pathname === '/app.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
    res.end(client.css)
    return
  }

  if (o.hub && method === 'GET' && url.pathname === '/api/evenements') {
    await serveEvents(req, res, url, o.hub)
    return
  }

  for (const route of o.routes ?? []) {
    if (route.method !== method) continue
    const match = url.pathname.match(route.pattern)
    if (!match) continue
    await route.handle(req, res, match, body)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('introuvable')
}

function serveEvents(req: IncomingMessage, res: ServerResponse, url: URL, hub: Hub): Promise<void> {
  const mission = url.searchParams.get('mission') || undefined
  const agents = url.searchParams.get('agents') === '1'
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const detach = hub.attach((event: ServerEvent) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }, { mission, agents })
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 15_000)
  ping.unref()
  return new Promise((resolve) => {
    let settled = false
    const close = () => {
      if (settled) return
      settled = true
      clearInterval(ping)
      detach()
      resolve()
    }
    res.on('close', close)
    res.on('error', close)
  })
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (status: 400 | 413, message: string) => {
      if (settled) return
      settled = true
      reject(Object.assign(new Error(message), { status }))
    }
    const ok = (value: unknown) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const declared = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      req.resume()
      fail(413, 'corps trop grand')
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY) {
        req.pause()
        fail(413, 'corps trop grand')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        ok(undefined)
        return
      }
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        fail(400, 'JSON invalide')
      }
    })
    req.on('error', () => {
      fail(400, 'lecture impossible')
    })
  })
}
