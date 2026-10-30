import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { missionDir } from '../paths.ts'
import { GateKindSchema } from './state.ts'

export const InboxMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('decision'),
    source: z.literal('user'),
    gateId: z.string(),
    decision: z.enum(['approved', 'refused']),
    note: z.string().optional(),
  }),
  z.object({
    type: z.literal('request-gate'),
    kind: GateKindSchema,
    summary: z.string(),
    path: z.string().optional(),
    hash: z.string().optional(),
  }),
  z.object({ type: z.literal('classified'), workType: z.string(), slug: z.string() }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('orchestrator-started') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('abandon'), reason: z.string() }),
])
export type InboxMessage = z.infer<typeof InboxMessageSchema>

function inboxDir(id: string): string {
  return join(missionDir(id), 'inbox')
}

let counter = 0

// <ms sur 15 chiffres>-<compteur du processus sur 6>-<pid>-<aléa> : l'ordre lexicographique est l'ordre de dépôt.
function nextName(): string {
  counter = (counter + 1) % 1_000_000
  return [
    String(Date.now()).padStart(15, '0'),
    String(counter).padStart(6, '0'),
    process.pid,
    randomBytes(4).toString('hex'),
  ].join('-')
}

export async function postInbox(id: string, msg: InboxMessage): Promise<void> {
  const dir = inboxDir(id)
  await mkdir(dir, { recursive: true })
  const name = nextName()
  const tmp = join(dir, `${name}.json.tmp`)
  await writeFile(tmp, JSON.stringify(msg))
  await rename(tmp, join(dir, `${name}.json`))
}

// Tolère les anciens noms `<ms>-<aléa>` : horodatage, puis compteur s'il existe, puis nom.
function order(name: string): [number, number, string] {
  const [ts, second] = name.split('-')
  const counter = /^\d{6}$/.test(second ?? '') ? Number(second) : 0
  return [Number(ts), counter, name]
}

export async function drainInbox(id: string): Promise<InboxMessage[]> {
  const dir = inboxDir(id)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  names = names
    .filter((n) => n.endsWith('.json'))
    .sort((a, b) => {
      const [ta, ca, na] = order(a)
      const [tb, cb, nb] = order(b)
      return ta - tb || ca - cb || (na < nb ? -1 : na > nb ? 1 : 0)
    })
  const out: InboxMessage[] = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      out.push(InboxMessageSchema.parse(JSON.parse(await readFile(file, 'utf8'))))
      await rm(file)
    } catch {
      await mkdir(join(dir, 'rejected'), { recursive: true })
      await rename(file, join(dir, 'rejected', name))
    }
  }
  return out
}
