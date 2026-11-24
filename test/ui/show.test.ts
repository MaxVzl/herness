import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { DocViewer, resolveDoc, type DocState, type ViewerChild, type ViewerDeps } from '../../src/ui/show.ts'
import { planPath, specPath } from '../../src/paths.ts'

const dir = '/m/gh12'
const base: DocState = { id: 'gh12', createdAt: '2026-03-04T10:00:00.000Z' }
const withSlug: DocState = { ...base, slug: 'export-csv', worktree: '/wt' }
const specFile = join('/wt', specPath({ id: 'gh12', slug: 'export-csv', createdAt: base.createdAt }))
const planFile = join('/wt', planPath({ id: 'gh12', slug: 'export-csv', createdAt: base.createdAt }))

describe('resolveDoc', () => {
  test('a pending proposal wins over the worktree file', () => {
    const files = new Set([join(dir, 'plan.proposed.md'), planFile])
    expect(resolveDoc('plan', withSlug, dir, (p) => files.has(p))).toEqual({ path: join(dir, 'plan.proposed.md'), proposed: true })
  })
  test('without a proposal, the worktree file', () => {
    expect(resolveDoc('spec', withSlug, dir, (p) => p === specFile)).toEqual({ path: specFile, proposed: false })
    expect(resolveDoc('plan', withSlug, dir, (p) => p === planFile)).toEqual({ path: planFile, proposed: false })
  })
  test('a spec proposal does not apply to the plan', () => {
    expect(resolveDoc('plan', withSlug, dir, (p) => p === join(dir, 'spec.proposed.md'))).toEqual({ missing: true, expected: planFile })
  })
  test('known slug but missing file: missing, with the expected path', () => {
    expect(resolveDoc('spec', withSlug, dir, () => false)).toEqual({ missing: true, expected: specFile })
  })
  test('unknown slug or worktree: missing without a path', () => {
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
      const c = new FakeChild(proposed ? `proposal:${f}` : f, slowKill)
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
  test('missing file: message with the expected path, once, without a viewer', async () => {
    const t = setup()
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.printed).toEqual([`spec not written yet\n${specFile}`])
    expect(t.children).toEqual([])
  })

  test('unknown slug: message without a path', async () => {
    const t = setup(base)
    await t.viewer.tick()
    expect(t.printed).toEqual(['spec not written yet'])
  })

  test('file appears: viewer started; unchanged: not restarted', async () => {
    const t = setup()
    await t.viewer.tick()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.children.map((c) => c.file)).toEqual([specFile])
  })

  test('mtime changed: old viewer killed, new one started', async () => {
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

  test("a proposal that appears replaces the file (copy with the header)", async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    t.files.set(join(dir, 'spec.proposed.md'), 5)
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.children.map((c) => c.file)).toEqual([specFile, `proposal:${join(dir, 'spec.proposed.md')}`])
    expect(t.children[0]!.killed).toBe(true)
  })

  test('voluntary exit: prompts to press Enter, no restart alone, Enter reopens', async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    t.children[0]!.exit()
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.printed).toEqual(['press Enter to reopen'])
    expect(t.inputOn()).toBe(true)
    expect(t.children).toHaveLength(1)
    t.press()
    await t.viewer.tick()
    expect(t.children).toHaveLength(2)
    expect(t.inputOn()).toBe(false)
  })

  test("voluntary exit then file changed: reopens without waiting for Enter", async () => {
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

  test("file disappears: viewer killed and waiting message", async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    t.files.delete(specFile)
    await t.viewer.tick()
    expect(t.children[0]!.killed).toBe(true)
    expect(t.printed.at(-1)).toContain('spec not written yet')
  })

  test("state read error: message then retry, the current viewer is kept", async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    t.setState(new Error('invalid JSON'))
    await t.viewer.tick()
    await t.viewer.tick()
    expect(t.printed).toEqual(['unreadable state, retrying: invalid JSON'])
    expect(t.children[0]!.killed).toBe(false)
    t.setState(withSlug)
    await t.viewer.tick()
    expect(t.children).toHaveLength(1)
  })

  test('debounce: a file that still changes on every tick restarts nothing', async () => {
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

  test("the new viewer starts only once the old one has really exited", async () => {
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

  test('spawn failure (file gone): message, no crash, retry on the next tick', async () => {
    const t = setup()
    t.files.set(specFile, 1)
    t.failSpawnOnce()
    await t.viewer.tick()
    expect(t.children).toEqual([])
    expect(t.printed.at(-1)).toContain('retrying: ENOENT')
    await t.viewer.tick()
    expect(t.children.map((c) => c.file)).toEqual([specFile])
  })

  test('close kills the viewer', async () => {
    const t = setup()
    t.files.set(specFile, 1)
    await t.viewer.tick()
    await t.viewer.close()
    expect(t.children[0]!.killed).toBe(true)
  })
})
