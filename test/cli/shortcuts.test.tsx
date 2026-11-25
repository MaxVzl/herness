import { execa } from 'execa'
import { render } from 'ink-testing-library'
import React from 'react'
import { expect, test } from 'vitest'
import { openGate } from '../../src/engine/gates.ts'
import { newState, type MissionState } from '../../src/mission/state.ts'
import { Cockpit, type CockpitActions } from '../../src/ui/cockpit.tsx'
import type { ActionResult } from '../../src/ui/actions.ts'
import { TasksDashboard } from '../../src/ui/tasks.tsx'
import { waitFor } from '../ui/wait.ts'

const COCKPIT_HELP = '(↑/↓ mission, ←/→ gate, a/r/n gate, u/R/c/o/D, + new mission, f finished, q quit)'
const TASKS_HELP = '(b back to the cockpit, q quit)'

const COMPOSITE_KEYS = ['↑/↓', '←/→']

/** Key tokens of a command description, split on `/` except the arrow pairs. */
function describedKeys(description: string): string[] {
  const paren = description.match(/\(([^)]*)\)/)
  if (!paren) throw new Error(`no shortcut list in ${description}`)
  return paren[1]!.split(',').flatMap((part) => {
    const token = part.trim().split(' ')[0]!
    if (COMPOSITE_KEYS.includes(token)) return [token]
    return token.split('/')
  })
}

/** Keys of the footer help (from `marker` through `q quit`), not the gate hint in the detail. */
function helpKeys(frame: string, marker: string): string[] {
  const lines = frame.split('\n')
  const start = lines.findIndex((l) => l.includes(marker))
  const end = lines.findIndex((l, i) => i >= start && l.includes('q quit'))
  if (start < 0 || end < 0) throw new Error(`help line "${marker}" missing\n${frame}`)
  const known = new Set([...COMPOSITE_KEYS, 'a', 'r', 'n', 'u', 'R', 'c', 'o', 'D', 'b', '+', 'f', 'q'])
  return lines
    .slice(start, end + 1)
    .join(' ')
    .split(' · ')
    .map((part) => part.trim().split(' ')[0]!)
    .filter((key) => known.has(key))
}

function mission(): MissionState {
  const s = newState({ id: '26110201-1', source: { kind: 'text', ref: 'open-one' }, project: 'p', repoPath: '/r' })
  s.slug = 'open-one'
  s.branch = 'feat/26110201-1-open-one'
  s.step = 'tasks'
  openGate(s, 'spec', 'A')
  openGate(s, 'plan', 'B')
  return s
}

function actions(): CockpitActions {
  const done = async (): Promise<ActionResult> => ({ ok: true, lines: [] })
  return {
    validate: done,
    refuse: done,
    resume: done,
    restart: done,
    close: done,
    remove: done,
    open: done,
    startNew: async () => done(),
  }
}

test('CLI help lists the same shortcuts as the cockpit and tasks help items', async () => {
  const help = await execa('node', ['bin/herness.js', '--help'], { reject: false, stdin: 'ignore' })
  const flat = help.stdout.replace(/\s+/g, ' ')
  expect(flat).toContain(COCKPIT_HELP)
  expect(flat).toContain(TASKS_HELP)

  const s = mission()
  const cockpit = render(
    <Cockpit
      repoPath="/r"
      name="demo"
      load={async () => [s]}
      actions={actions()}
      prCache={{ get: () => undefined, refresh: async () => {} }}
      columns={220}
    />,
  )
  await waitFor(cockpit.lastFrame, 'a approve')
  await waitFor(cockpit.lastFrame, 'q quit')
  const cockpitKeys = helpKeys(cockpit.lastFrame()!, '+ new mission')
  expect(cockpitKeys).toEqual(describedKeys(COCKPIT_HELP))

  const tasks = render(
    <TasksDashboard id={s.id} load={async () => s} actions={actions()} focusCockpit={async () => {}} intervalMs={60_000} />,
  )
  await waitFor(tasks.lastFrame, 'b cockpit')
  await waitFor(tasks.lastFrame, 'q quit')
  const taskKeys = helpKeys(tasks.lastFrame()!, 'b cockpit')
  const described = describedKeys(TASKS_HELP)
  expect(described).toEqual(['b', 'q'])
  for (const key of described) expect(taskKeys).toContain(key)
  expect(taskKeys).toContain('b')
  expect(flat).not.toContain('c back to the cockpit')
})
