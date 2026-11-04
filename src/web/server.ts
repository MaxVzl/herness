import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { checkRequest, tokensEqual } from './auth.ts'
import { buildClient } from './bundle.ts'

export interface Route {
  method: 'GET' | 'POST'
  pattern: RegExp
  handle(req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray, body: unknown): Promise<void>
}

export interface WebServerOptions {
  port: number
  token: string
  routes?: Route[]
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
  let port = o.port
  const server = createServer((req, res) => {
    void handle(req, res, { ...o, port }, client).catch((err: { status?: number }) => {
      if (res.headersSent) return
      const status = err.status === 413 || err.status === 400 ? err.status : 500
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
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

function plainHeaders(req: IncomingMessage): Record<string, string | string[] | undefined> {
  return req.headers
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
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const method = req.method ?? 'GET'

  if (method === 'GET' && url.pathname === '/' && url.searchParams.has('cle')) {
    const gate = checkRequest(
      { method: 'GET', headers: { ...plainHeaders(req), cookie: `herness_web=${o.token}` } },
      o.token,
      o.port,
    )
    if (!gate.ok) {
      deny(res, gate.status)
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

  const gate = checkRequest({ method, headers: plainHeaders(req) }, o.token, o.port)
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

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      req.resume()
      reject(Object.assign(new Error('corps trop grand'), { status: 413 }))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(Object.assign(new Error('corps trop grand'), { status: 413 }))
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => {
      if (size === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('JSON invalide'), { status: 400 }))
      }
    })
    req.on('error', () => {
      if (size > MAX_BODY) return
      reject(Object.assign(new Error('lecture impossible'), { status: 400 }))
    })
  })
}
