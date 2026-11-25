// EXAMPLE herness project config — never loaded (herness ignores the
// `example` directory) and points at a fake path.
//
// To add your project: copy this file to
//   ~/.config/herness/projects/<name>/config.ts
// (or $XDG_CONFIG_HOME/herness/projects, or $HERNESS_PROJECTS_DIR), then adapt it.
// The file must be standalone: no import of herness sources;
// herness validates the default export against its schema on load.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Project scripts live next to the config: their paths are
// resolved from this file's location.
const here = dirname(fileURLToPath(import.meta.url))

export default {
  // Short project name (used as a label in missions).
  name: 'example',
  // Absolute path of the main checkout. herness picks the project whose
  // `repoPath` contains the current directory.
  repoPath: '/path/to/your-project',
  // Branch targeted by pull requests.
  mainBranch: 'main',
  // Commit type -> branch prefix (`feature/<id>-<slug>`…).
  branchPrefixes: { feat: 'feature', fix: 'fix', chore: 'chore', refactor: 'chore', docs: 'chore', test: 'chore' },
  // Commit message format. Variables: {type}, {scope}, {description}, {id}.
  commitFormat: '{type}({scope}): {description} [{id}]',
  // Language code ('en', 'fr'…) of this project's specs, plans, commits and PRs.
  language: 'en',
  // Files agents must never modify (globs).
  forbiddenPaths: ['src/generated/**'],
  // Commands forbidden to agents.
  forbiddenCommands: ['git stash', '--no-verify'],
  // Prepare a fresh worktree (dependencies, .env…). Variable: {worktree}.
  prepare: [join(here, 'prepare-worktree.sh'), '{worktree}'],
  // Optional: test database private to the worktree. Variables: {id}, {worktree}.
  // testDb: {
  //   up: [join(here, 'test-db.sh'), 'up', '{id}', '{worktree}'],
  //   down: [join(here, 'test-db.sh'), 'down', '{id}', '{worktree}'],
  // },
  // Local checks before the PR, in order.
  preflight: [
    { label: 'typecheck', command: ['npm', 'run', 'typecheck'] },
    { label: 'lint', command: ['npm', 'run', 'lint'] },
    { label: 'test', command: ['npm', 'test'] },
  ],
  // Known preflight failures: `pattern` (regex on the log), `action`
  // ('retry' runs again, 'ignore' passes, 'cleanup' runs `cleanup` then runs again),
  // optional `label` to limit the match to one step.
  falsePositives: [
    {
      label: 'test',
      pattern: 'ECONNRESET',
      action: 'retry',
      explanation: 'Transient network drop: run again.',
    },
  ],
  // Orchestrator permission mode: 'auto' (default), 'acceptEdits',
  // 'bypassPermissions', 'manual', 'dontAsk' or 'plan'.
  orchestratorPermissionMode: 'auto',
  // Agent models.
  models: {
    orchestrator: 'claude-opus-5-5',
    reviewer: 'claude-opus-5-5',
    implementer: 'grok-4.7-medium',
    implementerStrong: 'grok-4.7-high',
  },
}
