// EXEMPLE de config de projet herness — n'est jamais chargé (herness ignore le
// dossier `exemple`) et vise un chemin factice.
//
// Pour ajouter ton projet : copie ce fichier dans
//   ~/.config/herness/projects/<nom>/config.ts
// (ou $XDG_CONFIG_HOME/herness/projects, ou $HERNESS_PROJECTS_DIR), puis adapte-le.
// Le fichier doit être autonome : pas d'import vers les sources de herness ;
// herness valide l'export par défaut avec son schéma au chargement.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Les scripts du projet se rangent à côté de la config : leurs chemins sont
// résolus depuis l'emplacement de ce fichier.
const here = dirname(fileURLToPath(import.meta.url))

export default {
  // Nom court du projet (sert d'étiquette dans les missions).
  name: 'exemple',
  // Chemin absolu du checkout principal. herness choisit le projet dont
  // `repoPath` contient le dossier courant.
  repoPath: '/chemin/vers/ton-projet',
  // Branche visée par les Pull Requests.
  mainBranch: 'main',
  // Type de commit -> préfixe de branche (`feature/<id>-<slug>`…).
  branchPrefixes: { feat: 'feature', fix: 'fix', chore: 'chore', refactor: 'chore', docs: 'chore', test: 'chore' },
  // Format des messages de commit. Variables : {type}, {scope}, {description}, {id}.
  commitFormat: '{type}({scope}): {description} [{id}]',
  // Fichiers que les agents ne doivent jamais modifier (globs).
  forbiddenPaths: ['src/generated/**'],
  // Commandes interdites aux agents.
  forbiddenCommands: ['git stash', '--no-verify'],
  // Préparation d'un worktree neuf (dépendances, .env…). Variable : {worktree}.
  prepare: [join(here, 'prepare-worktree.sh'), '{worktree}'],
  // Optionnel : base de test propre au worktree. Variables : {id}, {worktree}.
  // testDb: {
  //   up: [join(here, 'test-db.sh'), 'up', '{id}', '{worktree}'],
  //   down: [join(here, 'test-db.sh'), 'down', '{id}', '{worktree}'],
  // },
  // Vérifications locales avant la PR, dans l'ordre.
  preflight: [
    { label: 'typecheck', command: ['npm', 'run', 'typecheck'] },
    { label: 'lint', command: ['npm', 'run', 'lint'] },
    { label: 'test', command: ['npm', 'test'] },
  ],
  // Échecs connus du preflight : `pattern` (regex sur le journal), `action`
  // ('retry' relance, 'ignore' passe, 'cleanup' lance `cleanup` puis relance),
  // `label` optionnel pour limiter à une étape.
  falsePositives: [
    {
      label: 'test',
      pattern: 'ECONNRESET',
      action: 'retry',
      explanation: 'Coupure réseau passagère : relancer.',
    },
  ],
  // Mode de permissions de l'orchestrateur : 'auto' (défaut), 'acceptEdits',
  // 'bypassPermissions', 'manual', 'dontAsk' ou 'plan'.
  orchestratorPermissionMode: 'auto',
  // Modèles des agents.
  models: {
    orchestrator: 'claude-opus-5-5',
    reviewer: 'claude-opus-5-5',
    implementer: 'grok-4.7-medium',
    implementerStrong: 'grok-4.7-high',
  },
}
