import { expect, test } from 'vitest'
import { checkRequest, newToken } from '../../src/web/auth.ts'

const token = 'ab'.repeat(32)

test('newToken rend 64 caractères hexadécimaux, différents d’un appel à l’autre', () => {
  const a = newToken()
  const b = newToken()
  expect(a).toMatch(/^[0-9a-f]{64}$/)
  expect(b).toMatch(/^[0-9a-f]{64}$/)
  expect(a).not.toBe(b)
})

test('checkRequest sans cookie répond 401', () => {
  expect(checkRequest({ method: 'GET', headers: { host: 'localhost:4747' } }, token, 4747)).toEqual({
    ok: false,
    status: 401,
  })
})

test('checkRequest accepte GET avec le bon cookie et Host localhost', () => {
  expect(checkRequest({
    method: 'GET',
    headers: { host: 'localhost:4747', cookie: `herness_web=${token}` },
  }, token, 4747)).toEqual({ ok: true })
})

test('checkRequest refuse Host evil.com', () => {
  expect(checkRequest({
    method: 'GET',
    headers: { host: 'evil.com', cookie: `herness_web=${token}` },
  }, token, 4747)).toEqual({ ok: false, status: 403 })
})

test('checkRequest refuse un POST dont Origin est http://evil.com', () => {
  expect(checkRequest({
    method: 'POST',
    headers: {
      host: 'localhost:4747',
      cookie: `herness_web=${token}`,
      origin: 'http://evil.com',
    },
  }, token, 4747)).toEqual({ ok: false, status: 403 })
})

test('checkRequest refuse un POST sans Origin', () => {
  expect(checkRequest({
    method: 'POST',
    headers: { host: 'localhost:4747', cookie: `herness_web=${token}` },
  }, token, 4747)).toEqual({ ok: false, status: 403 })
})

test('checkRequest accepte un POST dont Origin est http://127.0.0.1:4747', () => {
  expect(checkRequest({
    method: 'POST',
    headers: {
      host: '127.0.0.1:4747',
      cookie: `herness_web=${token}`,
      origin: 'http://127.0.0.1:4747',
    },
  }, token, 4747)).toEqual({ ok: true })
})
