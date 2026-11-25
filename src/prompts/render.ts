import { readFile } from 'node:fs/promises'

const KEY = /\{\{\s*(\w+)\s*\}\}/g

/** Renders the `src/prompts/<name>.md` template, replacing each `{{key}}`. */
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
    throw new Error(`Template ${name}: missing values for ${[...missing].join(', ')}`)
  }
  return out
}
