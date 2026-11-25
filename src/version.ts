import { readFileSync } from 'node:fs'

/** herness version, read from `package.json`: the single place to change for a new version. */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version
