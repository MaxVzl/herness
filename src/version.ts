import { readFileSync } from 'node:fs'

/** Version de herness, lue dans `package.json` : un seul endroit à changer pour une nouvelle version. */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version
