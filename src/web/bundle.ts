import { build, type OutputFile } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

export async function buildClient(): Promise<{ js: string; css: string }> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, 'src/web/client/main.tsx')],
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    minify: true,
    outfile: join(root, 'app.js'),
    platform: 'browser',
    logLevel: 'silent',
  })
  const files = result.outputFiles
  return { js: textEnding(files, '.js'), css: textEnding(files, '.css') }
}

function textEnding(files: OutputFile[], ext: string): string {
  const file = files.find((item) => item.path.endsWith(ext))
  if (!file) throw new Error(`paquet client sans fichier ${ext}`)
  return file.text
}
