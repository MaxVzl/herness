// Fake project config for tests: none of these scripts is executed,
// tests only compare the commands that are built.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectConfig } from '../../../src/config/project.ts'

const here = dirname(fileURLToPath(import.meta.url))
const testDb = join(here, 'test-db.sh')
const prepareWorktree = join(here, 'prepare-worktree.sh')

const config: ProjectConfig = {
  name: 'demo',
  repoPath: '/tmp/projet-demo',
  mainBranch: 'main',
  branchPrefixes: { feat: 'feature', fix: 'fix', chore: 'chore', refactor: 'chore', docs: 'chore', test: 'chore' },
  commitFormat: '{type}({scope}): {description} [{id}]',
  language: 'en',
  forbiddenPaths: ['apps/api/openapi.json', 'packages/api-client/src/generated/**'],
  forbiddenCommands: ['git stash', '--no-verify', 'docker compose'],
  prepare: [prepareWorktree, '{worktree}'],
  testDb: {
    up: [testDb, 'up', '{id}', '{worktree}'],
    down: [testDb, 'down', '{id}', '{worktree}'],
  },
  preflight: [
    { label: 'format:check', command: ['pnpm', 'format:check'] },
    { label: 'typecheck', command: ['pnpm', 'typecheck'] },
    { label: 'lint', command: ['pnpm', 'lint'] },
    { label: 'build', command: ['pnpm', '--filter', '@demo/api', 'build'] },
    { label: 'test', command: ['pnpm', 'test'] },
  ],
  falsePositives: [
    {
      label: 'format:check',
      pattern: 'Code style issues found',
      action: 'ignore',
      explanation: 'CRLF artifact of the worktree: ignore it when Prettier lists no file touched by the branch.',
    },
    {
      pattern: 'Module not found.*Roboto|Roboto.*Module not found',
      action: 'retry',
      explanation: 'Fetching the Roboto font failed (network flake): retry.',
    },
    {
      pattern: 'apps/api/src/test/setup.ts',
      action: 'cleanup',
      cleanup: ['pkill', '-f', '{worktree}/node_modules/.*vitest'],
      explanation: 'Orphan vitest processes: kill them, then retry.',
    },
    {
      pattern: "Cannot find module '../generated/client'",
      action: 'cleanup',
      cleanup: [prepareWorktree, '{worktree}'],
      explanation: 'SDK not generated in the worktree: rerun preparation, then retry.',
    },
  ],
  orchestratorPermissionMode: 'auto',
  models: {
    orchestrator: 'claude-opus-5-5',
    reviewer: 'claude-opus-5-5',
    implementer: 'grok-4.7-medium',
    implementerStrong: 'grok-4.7-high',
  },
}

export default config
