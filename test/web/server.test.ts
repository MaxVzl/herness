import { request as httpRequest } from 'node:http'
import { afterEach, expect, test, vi } from 'vitest'
import { newToken } from '../../src/web/auth.ts'
import { startWebServer, type Route } from '../../src/web/server.ts'

const servers: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

test('GET /?cle=<jeton> redirige vers / et pose le cookie', async () => {
  const token = newToken()
  const server = await startWebServer({ port: 0, token })
  servers.push(server)
  const res = await fetch(server.url, { redirect: 'manual' })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('/')
  const setCookie = res.headers.getSetCookie().join('; ')
  expect(setCookie).toContain(`herness_web=${token}`)
  expect(setCookie).toContain('HttpOnly')
  expect(setCookie).toContain('SameSite=Strict')
})

test('GET /?cle=mauvais répond 401', async () => {
  const token = newToken()
  const server = await startWebServer({ port: 0, token })
  servers.push(server)
  const res = await fetch(`http://localhost:${server.port}/?cle=mauvais`, { redirect: 'manual' })
  expect(res.status).toBe(401)
})

test('GET / avec le cookie sert la page empaquetée', async () => {
  const token = newToken()
  const server = await startWebServer({ port: 0, token })
  servers.push(server)
  const res = await fetch(`http://127.0.0.1:${server.port}/`, {
    headers: { cookie: `herness_web=${token}` },
  })
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain('<div id="app">')
  expect(html).toContain('/app.js')
  expect(html).toContain('/app.css')
})

test('GET /app.js avec le cookie sert le JavaScript', async () => {
  const token = newToken()
  const server = await startWebServer({ port: 0, token })
  servers.push(server)
  const res = await fetch(`http://127.0.0.1:${server.port}/app.js`, {
    headers: { cookie: `herness_web=${token}` },
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type') ?? '').toMatch(/javascript/i)
  expect((await res.text()).length).toBeGreaterThan(0)
})

test('GET / sans cookie répond 401 et demande de relancer herness web', async () => {
  const token = newToken()
  const server = await startWebServer({ port: 0, token })
  servers.push(server)
  const res = await fetch(`http://127.0.0.1:${server.port}/`)
  expect(res.status).toBe(401)
  expect(await res.text()).toContain('relance herness web')
})

function cookie(token: string, port: number): Record<string, string> {
  return { cookie: `herness_web=${token}`, host: `127.0.0.1:${port}` }
}

test('une route qui lève est consignée et répond 500', async () => {
  const token = newToken()
  const logged: unknown[][] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    logged.push(args)
  })
  const boom: Route = {
    method: 'GET',
    pattern: /^\/api\/boom$/,
    handle: () => Promise.reject(new Error('panne de route')),
  }
  const server = await startWebServer({ port: 0, token, routes: [boom] })
  servers.push(server)
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/boom`, {
      headers: cookie(token, server.port),
    })
    expect(res.status).toBe(500)
    expect(logged.some((args) => args.some((arg) => arg instanceof Error && arg.message === 'panne de route'))).toBe(true)
  } finally {
    spy.mockRestore()
  }
})

test('une route qui a déjà envoyé les en-têtes puis lève termine la réponse', async () => {
  const token = newToken()
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const route: Route = {
    method: 'GET',
    pattern: /^\/api\/coupe$/,
    handle: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      throw new Error('après en-têtes')
    },
  }
  const server = await startWebServer({ port: 0, token, routes: [route] })
  servers.push(server)
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/coupe`, {
      headers: cookie(token, server.port),
      signal: AbortSignal.timeout(1000),
    })
    expect(res.status).toBe(200)
    await res.text()
  } finally {
    spy.mockRestore()
  }
})

test('un Host mal formé répond 403', async () => {
  const token = newToken()
  const server = await startWebServer({ port: 0, token })
  servers.push(server)
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/',
      headers: { cookie: `herness_web=${token}`, host: '%' },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
  expect(status).toBe(403)
})

test('un POST sans Content-Length au-delà de 1 Mo répond 413', async () => {
  const token = newToken()
  const server = await startWebServer({
    port: 0,
    token,
    routes: [{ method: 'POST', pattern: /^\/api\/corps$/, handle: async () => {} }],
  })
  servers.push(server)
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/api/corps',
      method: 'POST',
      headers: {
        cookie: `herness_web=${token}`,
        host: `127.0.0.1:${server.port}`,
        origin: `http://127.0.0.1:${server.port}`,
        'content-type': 'application/json',
      },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.write('{"a":"')
    req.write('x'.repeat(1024 * 1024))
    req.end('"}')
  })
  expect(status).toBe(413)
})

test('GET /?cle=<bon jeton> avec un Host étranger répond 403', async () => {
  const token = newToken()
  const server = await startWebServer({ port: 0, token })
  servers.push(server)
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: server.port,
      path: `/?cle=${token}`,
      headers: { host: 'evil.com' },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
  expect(status).toBe(403)
})

test('un POST dont le JSON est invalide répond 400', async () => {
  const token = newToken()
  const server = await startWebServer({
    port: 0,
    token,
    routes: [{ method: 'POST', pattern: /^\/api\/corps$/, handle: async () => {} }],
  })
  servers.push(server)
  const res = await fetch(`http://127.0.0.1:${server.port}/api/corps`, {
    method: 'POST',
    headers: {
      ...cookie(token, server.port),
      origin: `http://127.0.0.1:${server.port}`,
      'content-type': 'application/json',
    },
    body: '{',
  })
  expect(res.status).toBe(400)
})

test('une route fournie reçoit la requête authentifiée', async () => {
  const token = newToken()
  let seen: unknown
  const server = await startWebServer({
    port: 0,
    token,
    routes: [{
      method: 'POST',
      pattern: /^\/api\/echo$/,
      handle: async (_req, res, _match, body) => {
        seen = body
        res.writeHead(204)
        res.end()
      },
    }],
  })
  servers.push(server)
  const res = await fetch(`http://127.0.0.1:${server.port}/api/echo`, {
    method: 'POST',
    headers: {
      ...cookie(token, server.port),
      origin: `http://127.0.0.1:${server.port}`,
      'content-type': 'application/json',
    },
    body: '{"ok":true}',
  })
  expect(res.status).toBe(204)
  expect(seen).toEqual({ ok: true })
})

test('un second serveur sur le même port est rejeté', async () => {
  const token = newToken()
  const server = await startWebServer({ port: 0, token })
  servers.push(server)
  await expect(startWebServer({ port: server.port, token: newToken() })).rejects.toThrow(
    /déjà utilisé par un autre programme/,
  )
})
