import { readFile } from 'node:fs/promises'

const KEY = /\{\{\s*(\w+)\s*\}\}/g

/** Rend le gabarit `src/prompts/<name>.md` en remplaçant les `{{clé}}`. */
export async function render(name: string, vars: Record<string, string>): Promise<string> {
  const raw = await readFile(new URL(`./${name}.md`, import.meta.url), 'utf8')
  const missing = new Set<string>()
  const out = raw.replace(KEY, (_m, key: string) => {
    const v = vars[key]
    if (v === undefined) {
      missing.add(key)
      return ''
    }
    return v
  })
  if (missing.size > 0) {
    throw new Error(`Gabarit ${name} : valeurs manquantes pour ${[...missing].join(', ')}`)
  }
  return out
}
