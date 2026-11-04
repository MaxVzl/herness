import { afterEach, expect, test } from 'vitest'
import { newToken } from '../../src/web/auth.ts'
import { startWebServer } from '../../src/web/server.ts'

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

test('un second serveur sur le même port est rejeté', async () => {
  const token = newToken()
  const server = await startWebServer({ port: 0, token })
  servers.push(server)
  await expect(startWebServer({ port: server.port, token: newToken() })).rejects.toThrow(
    /déjà utilisé par un autre programme/,
  )
})
