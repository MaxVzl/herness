import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { DocViewer, resolveDoc, type DocState, type ViewerChild, type ViewerDeps } from '../../src/ui/voir.ts'
import { planPath, specPath } from '../../src/paths.ts'

const dir = '/m/gh12'
const base: DocState = { id: 'gh12', createdAt: '2026-03-04T10:00:00.000Z' }
const withSlug: DocState = { ...base, slug: 'export-csv', worktree: '/wt' }
const specFile = join('/wt', specPath({ id: 'gh12', slug: 'export-csv', createdAt: base.createdAt }))
const planFile = join('/wt', planPath({ id: 'gh12', slug: 'export-csv', createdAt: base.createdAt }))

describe('resolveDoc', () => {
  test('la proposition en attente gagne sur le fichier du worktree', () => {
    const files = new Set([join(dir, 'plan.proposed.md'), planFile])
    expect(resolveDoc('plan', withSlug, dir, (p) => files.has(p))).toEqual({ path: join(dir, 'plan.proposed.md'), proposed: true })
  })
  test('sans proposition, le fichier du worktree', () => {
    expect(resolveDoc('spec', withSlug, dir, (p) => p === specFile)).toEqual({ path: specFile, proposed: false })
    expect(resolveDoc('plan', withSlug, dir, (p) => p === planFile)).toEqual({ path: planFile, proposed: false })
  })
  test('une proposition de spec ne concerne pas le plan', () => {
    expect(resolveDoc('plan', withSlug, dir, (p) => p === join(dir, 'spec.proposed.md'))).toEqual({ missing: true, expected: planFile })
  })
  test('slug connu mais fichier absent : manquant, avec le chemin attendu', () => {
    expect(resolveDoc('spec', withSlug, dir, () => false)).toEqual({ missing: true, expected: specFile })
  })
  test('slug (ou worktree) inconnu : manquant sans chemin', () => {
    expect(resolveDoc('spec', base, dir, () => false)).toEqual({ missing: true })
    expect(resolveDoc('spec', { ...base, slug: 'x' }, dir, () => false)).toEqual({ missing: true })
  })
})

class FakeChild implements ViewerChild {
  killed = false
  private cbs: (() => void)[] = []
  private waiters: (() => void)[] = []
  constructor(readonly file: string, private readonly slowKill: boolean) {}
  kill(): Promise<void> {
    this.killed = true
    const p = new Promise<void>((r) => void this.waiters.push(r))
    if (!this.slowKill) this.exit()
    return p
  }
  onExit(cb: () => void): void {
    this.cbs.push(cb)
  }
  exit(): void {
    for (const cb of this.cbs) cb()
    for (const w of this.waiters) w()
    this.waiters = []
  }
}

function setup(initial: DocState = withSlug) {
  const files = new Map<string, number>()
  const children: FakeChild[] = []
  const printed: string[] = []
  let state: DocState | Error = initial
  let enter = false
  let inputOn = false
  let slowKill = false
  let failSpawn = 0
  const deps: ViewerDeps = {
    readState: async () => {
      if (state instanceof Error) throw state
      return state
    },
    exists: (p) => files.has(p),
    mtime: (p) => files.get(p) ?? null,
    spawn: (f, proposed) => {
      if (failSpawn > 0) {
        failSpawn--
        throw new Error('ENOENT')
      }
      const c = new FakeChild(proposed ? `proposition:${f}` : f, slowKill)
      children.push(c)
      return c
    },
    print: (l) => void printed.push(l),
    input: {
      start: () => void (inputOn = true),
      stop: () => void (inputOn = false),
      pressed: () => {
        const was = enter
        enter = false
        return was
      },
    },
  }
  const viewer = new DocViewer('spec', dir, deps)
  return {
    viewer, files, children, printed,
    setState: (s: DocState | Error) => void (state = s),
    press: () => void (enter = true),
    inputOn: () => inputOn,
    slowKill: () => void (slowKill = true),
    failSpawnOnce: () => void (failSpawn = 1),
  }
}

describe('DocViewer', () => {
  test('fichier absent : message avec le chemin attendu, une seule fois, sans afficheur', async () => {
    const t = setup()
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.printed).toEqual([`spec pas encore écrite\n${specFile}`])
    expect(t.children).toEqual([])
  })

  test('slug inconnu : message sans chemin', async () => {
    const t = setup(base)
    await t.viewer.tick()
    expect(t.printed).toEqual(['spec pas encore écrite'])
  })

  test('le fichier apparaît : afficheur lancé ; inchangé : pas de relance', async () => {
    const t = setup()
    await t.viewer.tick()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.children.map((c) => c.file)).toEqual([specFile])
  })

  test('mtime modifié : ancien afficheur tué, nouveau lancé', async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    t.files.set(specFile, 2)
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.children).toHaveLength(2)
    expect(t.children[0]!.killed).toBe(true)
    expect(t.children[1]!.killed).toBe(false)
  })

  test("une proposition qui apparaît remplace le fichier (copie avec l'en-tête)", async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    t.files.set(join(dir, 'spec.proposed.md'), 5)
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.children.map((c) => c.file)).toEqual([specFile, `proposition:${join(dir, 'spec.proposed.md')}`])
    expect(t.children[0]!.killed).toBe(true)
  })

  test('sortie volontaire : invite à appuyer sur Entrée, pas de relance seule, Entrée rouvre', async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    t.children[0]!.exit()
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.printed).toEqual(['appuie sur Entrée pour rouvrir'])
    expect(t.inputOn()).toBe(true)
    expect(t.children).toHaveLength(1)
    t.press()
    await t.viewer.tick()
    expect(t.children).toHaveLength(2)
    expect(t.inputOn()).toBe(false)
  })

  test("sortie volontaire puis fichier modifié : rouvre sans attendre Entrée", async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    t.children[0]!.exit()
    t.files.set(specFile, 2)
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.children).toHaveLength(2)
    expect(t.children[0]!.killed).toBe(false)
  })

  test("le fichier disparaît : afficheur tué et message d'attente", async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    t.files.delete(specFile)
    await t.viewer.tick()
    expect(t.children[0]!.killed).toBe(true)
    expect(t.printed.at(-1)).toContain('spec pas encore écrite')
  })

  test("erreur de lecture de l'état : message puis nouvel essai, l'afficheur en cours est conservé", async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    t.setState(new Error('JSON invalide'))
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.printed).toEqual(['état illisible, nouvel essai : JSON invalide'])
    expect(t.children[0]!.killed).toBe(false)
    t.setState(withSlug)
    await t.viewer.tick()
    expect(t.children).toHaveLength(1)
  })

  test('debounce : un fichier qui change encore à chaque tick ne relance rien', async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    for (const m of [2, 3, 4]) {
      t.files.set(specFile, m)
      await t.viewer.tick()
    }
    expect(t.children).toHaveLength(1)
    expect(t.children[0]!.killed).toBe(false)
    await t.viewer.tick()
    expect(t.children).toHaveLength(2)
  })

  test("le nouvel afficheur n'est lancé qu'une fois l'ancien vraiment sorti", async () => {
    const t = setup()
    t.slowKill()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    t.files.set(specFile, 2)
    await t.viewer.tick()
    const second = t.viewer.tick()
    await Promise.resolve()
    await Promise.resolve()
    expect(t.children[0]!.killed).toBe(true)
    expect(t.children).toHaveLength(1)
    t.children[0]!.exit()
    await second
    expect(t.children).toHaveLength(2)
  })

  test('lancement impossible (fichier disparu) : message, pas de plantage, nouvel essai au tick suivant', async () => {
    const t = setup()
    t.files.set(specFile, 1)
    t.failSpawnOnce()
    await t.viewer.tick()
    expect(t.children).toEqual([])
    expect(t.printed.at(-1)).toContain('nouvel essai : ENOENT')
    await t.viewer.tick()
    expect(t.children.map((c) => c.file)).toEqual([specFile])
  })

  test('close tue l’afficheur', async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    await t.viewer.close()
    expect(t.children[0]!.killed).toBe(true)
  })
})
