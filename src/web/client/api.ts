import type { ActionResponse } from '../protocol.ts'

export async function post(path: string, body?: unknown): Promise<ActionResponse> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return await res.json() as ActionResponse
  } catch {
    return { ok: false, lines: ['serveur injoignable'] }
  }
}

export async function getText(path: string): Promise<string> {
  const res = await fetch(path)
  return res.text()
}
