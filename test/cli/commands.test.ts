import { execa } from 'execa'
import { expect, test } from 'vitest'

const help = (...args: string[]) =>
  execa('node', ['bin/herness.js', ...args, '--help'], { reject: false, stdin: 'ignore' })

test('the CLI exposes English commands and no French aliases', async () => {
  const r = await help()
  expect(r.exitCode).toBe(0)
  const names = [...(r.stdout.split('Commands:')[1] ?? '').matchAll(/^  ([a-z][a-z-]*)/gm)].map((m) => m[1])
  for (const name of ['approve', 'reject', 'resume', 'close', 'report', 'delete', 'project', 'update', 'status', 'show', 'cockpit', 'init', 'tasks', 'dev']) {
    expect(names).toContain(name)
  }
  for (const old of ['valider', 'refuser', 'reprendre', 'fermer', 'signaler', 'supprimer', 'projet', 'mise-a-jour', 'statut', 'voir']) {
    expect(names).not.toContain(old)
  }
})

test('English options replace the French ones', async () => {
  const approve = await help('approve')
  expect(approve.stdout).toContain('--gate')
  expect(approve.stdout).not.toContain('--porte')
  const resume = await help('resume')
  expect(resume.stdout).toContain('--restart')
  expect(resume.stdout).not.toContain('--redemarrer')
  const report = await help('report')
  expect(report.stdout).toContain('--yes')
  expect(report.stdout).not.toContain('--oui')
  const dev = await help('dev')
  expect(dev.stdout).toContain('<request...>')
  expect(dev.stdout).not.toContain('<demande...>')
})
