import { spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, expect, test } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', '..', 'install.sh')

let root: string
let releases: string
let data: string
let binDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'herness-install-'))
  releases = join(root, 'releases')
  data = join(root, 'data')
  binDir = join(root, 'bin')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Publie une fausse release : `bin/herness` affiche sa version, `post-install` (facultatif) laisse une trace. */
async function release(version: string, opts: { postInstall?: 'ok' | 'fail' | 'none'; noBin?: boolean; latest?: boolean } = {}): Promise<void> {
  const src = join(root, 'src', version)
  const top = join(src, `herness-${version}`)
  await mkdir(join(top, 'bin'), { recursive: true })
  if (!opts.noBin) {
    await writeFile(join(top, 'bin', 'herness'), `#!/bin/sh\necho "herness ${version} $*"\n`)
    await chmod(join(top, 'bin', 'herness'), 0o755)
  }
  const post = opts.postInstall ?? 'ok'
  if (post !== 'none') {
    await writeFile(join(top, 'bin', 'post-install'), post === 'ok'
      ? '#!/bin/sh\nset -e\ncd "$(dirname "$0")/.."\npwd > prepared\n'
      : '#!/bin/sh\necho "dépendances cassées" >&2\nexit 3\n')
    await chmod(join(top, 'bin', 'post-install'), 0o755)
  }
  await mkdir(join(releases, `v${version}`), { recursive: true })
  await execa('tar', ['-czf', join(releases, `v${version}`, `herness-${version}.tar.gz`), '-C', src, `herness-${version}`])
  if (opts.latest !== false) await writeFile(join(releases, 'latest.json'), JSON.stringify({ tag_name: `v${version}`, name: `v${version}` }, null, 2))
}

function install(...args: string[]) {
  return execa('sh', [SCRIPT, ...args], {
    reject: false,
    env: {
      HERNESS_INSTALL_DIR: data,
      HERNESS_BIN_DIR: binDir,
      HERNESS_RELEASES_URL: `file://${releases}`,
      HERNESS_LATEST_URL: `file://${join(releases, 'latest.json')}`,
      PATH: `${binDir}:${process.env.PATH}`,
    },
  })
}

const herness = async (...args: string[]) => (await execa(join(binDir, 'herness'), args)).stdout
const versions = async () => (await readdir(join(data, 'versions'))).filter((v) => !v.startsWith('.')).sort()

test('installe la dernière version : dossier par version, lien current, lien dans le PATH, post-install lancé sur place', async () => {
  await release('0.5.0')
  const r = await install()
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toContain('herness 0.5.0 installé')
  expect(r.stdout).not.toContain("n'est pas dans le PATH")
  expect(await readlink(join(data, 'current'))).toBe('versions/0.5.0')
  expect(await readlink(join(binDir, 'herness'))).toBe(join(data, 'current', 'bin', 'herness'))
  expect(await herness('statut')).toBe('herness 0.5.0 statut')
  // Préparée à sa place définitive, pas dans un dossier temporaire.
  expect((await readFile(join(data, 'versions', '0.5.0', 'prepared'), 'utf8')).trim()).toBe(join(data, 'versions', '0.5.0'))
  expect(await readdir(join(data, 'versions'))).toEqual(['0.5.0'])
})

test('mise à jour puis retour arrière avec --version', async () => {
  await release('0.5.0')
  await install()
  await release('0.6.0')
  const up = await install()
  expect(up.stdout).toContain('herness 0.5.0 → 0.6.0')
  expect(await herness()).toBe('herness 0.6.0 ')
  const back = await install('--version', 'v0.5.0')
  expect(back.exitCode).toBe(0)
  expect(back.stdout).toContain('déjà présent')
  expect(back.stdout).toContain('herness 0.6.0 → 0.5.0')
  expect(await herness()).toBe('herness 0.5.0 ')
})

test('garde les 3 versions les plus récentes', async () => {
  for (const v of ['0.5.0', '0.6.0', '0.9.0', '0.10.0']) {
    await release(v)
    expect((await install()).exitCode).toBe(0)
  }
  // Tri par version, pas alphabétique : 0.10.0 est la plus récente.
  expect(await versions()).toEqual(['0.10.0', '0.6.0', '0.9.0'])
})

test('ne supprime pas une version encore utilisée par un processus', async () => {
  for (const v of ['0.5.0', '0.6.0', '0.7.0']) {
    await release(v)
    await install()
  }
  // Un « moteur » lancé depuis la plus ancienne version : son chemin est dans sa ligne de commande.
  const busy = spawn('sh', ['-c', 'sleep 30; :', join(data, 'versions', '0.5.0', 'bin', 'herness')], { stdio: 'ignore' })
  try {
    await release('0.8.0')
    const r = await install()
    expect(r.stdout).toContain('herness 0.5.0 gardé : encore utilisé')
    expect(await versions()).toEqual(['0.5.0', '0.6.0', '0.7.0', '0.8.0'])
  } finally {
    busy.kill()
  }
})

test('post-install en échec : version retirée, version active inchangée', async () => {
  await release('0.5.0')
  await install()
  await release('0.6.0', { postInstall: 'fail' })
  const r = await install()
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr).toContain('préparation de herness 0.6.0 échouée : version actuelle inchangée (0.5.0)')
  expect(r.stderr).toContain('dépendances cassées')
  expect(await versions()).toEqual(['0.5.0'])
  expect(await herness()).toBe('herness 0.5.0 ')
})

test('archive sans bin/herness : refusée', async () => {
  await release('0.5.0', { noBin: true })
  const r = await install()
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr).toContain('bin/herness absent')
  await expect(access(join(data, 'current'))).rejects.toThrow()
})

test('version introuvable : erreur claire, rien de laissé', async () => {
  await release('0.5.0')
  const r = await install('--version', '9.9.9')
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr).toContain('téléchargement impossible')
  expect(await readdir(join(data, 'versions'))).toEqual([])
})

test('remplace un ancien lien (dépôt de dev) en le signalant, refuse un vrai fichier', async () => {
  await release('0.5.0')
  await mkdir(binDir, { recursive: true })
  await execa('ln', ['-s', '/ailleurs/bin/herness.js', join(binDir, 'herness')])
  const r = await install()
  expect(r.stdout).toContain(`ancien lien remplacé : ${join(binDir, 'herness')} pointait vers /ailleurs/bin/herness.js`)
  expect(await herness()).toBe('herness 0.5.0 ')

  await rm(join(binDir, 'herness'))
  await writeFile(join(binDir, 'herness'), 'à moi')
  const refused = await install()
  expect(refused.exitCode).not.toBe(0)
  expect(refused.stderr).toContain("existe et n'est pas un lien")
})

test('version invalide refusée', async () => {
  const r = await install('--version', '1.0;rm -rf /')
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr).toContain('version invalide')
})

test('les points d’entrée du dépôt respectent le contrat de l’archive', async () => {
  const repo = join(import.meta.dirname, '..', '..')
  for (const f of ['bin/herness', 'bin/post-install', 'install.sh']) {
    expect((await stat(join(repo, f))).mode & 0o111).toBeTruthy()
  }
  // Le lanceur résout son vrai dossier : appelé par un lien, il trouve quand même herness.js.
  const link = join(root, 'lien-herness')
  await execa('ln', ['-s', join(repo, 'bin', 'herness'), link])
  const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as { version: string }
  expect((await execa(link, ['--version'], { stdin: 'ignore' })).stdout.trim()).toBe(version)
})
