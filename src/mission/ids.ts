import { readdir } from 'node:fs/promises'
import { missionsRoot } from '../paths.ts'

export type Demande =
  | { kind: 'wrike'; id: string; ref: string }
  | { kind: 'github'; id: string; ref: string; number: number }
  | { kind: 'text'; ref: string }

export function parseDemande(input: string): Demande {
  const ref = input.trim()
  if (/^https?:\/\/([^/]+\.)?wrike\.com\//i.test(ref)) {
    const id = new URL(ref).searchParams.get('id')
    if (!id) throw new Error('lien Wrike sans id')
    return { kind: 'wrike', id, ref }
  }
  const gh = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)(?:[/?#].*)?$/i.exec(ref)
  if (gh) {
    const number = Number(gh[1])
    return { kind: 'github', id: `gh${number}`, number, ref }
  }
  return { kind: 'text', ref }
}

export async function nextFreeTextId(today: Date): Promise<string> {
  const pad = (n: number) => String(n).padStart(2, '0')
  const prefix = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`
  let existing: string[] = []
  try {
    existing = await readdir(missionsRoot())
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const n = existing.filter((d) => d.startsWith(`${prefix}-`)).length
  return `${prefix}-${n + 1}`
}
