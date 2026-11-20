# Cockpit périmé : plan d'implémentation

> **Pour les agents :** exécuter tâche par tâche, en TDD (test d'abord, rouge, code minimal, vert). Les étapes utilisent des cases `- [ ]`.

**But :** tout processus que herness lance démarre avec la version installée active, et un cockpit plus vieux que cette version l'affiche.

**Architecture :** `src/update.ts` devient la seule source de « comment lancer herness ». `hernessCommand()` renvoie le lanceur installé (`<install>/current/bin/herness`) quand le processus tourne depuis une version installée, sinon `node <racine>/bin/herness.js`. `shellLine()` met cette commande en forme pour un panneau herdr. Les quatre points de lancement (`lifecycle.ts`, `ui/actions.ts`, `mcp/server.ts`, `ui/location.ts`) l'utilisent. `staleNotice()` calcule le texte du bandeau, que le cockpit relit à chaque rafraîchissement.

**Stack :** TypeScript exécuté par tsx (Node ≥ 24), ink/React pour le cockpit, vitest.

**Spec :** `docs/superpowers/specs/2026-11-20-20261120-2-cockpit-version-perimee.md`

## Contraintes globales

- Dossier d'installation : `HERNESS_INSTALL_DIR`, sinon `$XDG_DATA_HOME/herness`, sinon `$HOME/.local/share/herness` (calcul actuel d'`installedBin`, une seule source).
- Lanceur installé : `<dossier d'installation>/current/bin/herness`, un script shell exécutable lancé directement, jamais via `node`.
- Hors installation (sources, tests), le comportement reste celui d'aujourd'hui : `node '<racine du paquet>/bin/herness.js' …`.
- Texte exact du bandeau : `herness <installée> installé, ce cockpit tourne en <la sienne> : quitte-le et relance herness`, en jaune.
- Hors périmètre : `controlCommits`, `src/config/init.ts`, `install.sh`, relance automatique du cockpit.
- Commits au format Conventional Commits en français, par exemple `fix: …` ou `feat(cockpit): …`. Tests lancés avec `pnpm exec vitest run <fichiers>`.

## Points de vigilance pour la revue

1. Racine du paquet atteinte par un lien (`current` → `versions/0.8.0`) : comparer les chemins **réels** (`realpathSync`), sinon une version installée passe pour un dossier de sources.
2. Version installée dont `current/bin/herness` manque (installation incomplète) : retomber sur `node <racine>/bin/herness.js`, ne pas lancer un chemin absent.
3. `current/package.json` absent, illisible ou sans `version` : pas de bandeau et pas d'exception, le cockpit continue d'afficher les missions.
4. Chemins contenant une espace ou une apostrophe : la ligne tapée dans le panneau herdr doit rester correctement citée.
5. Tests et développement local : la racine du dépôt n'est pas sous `versions/`, donc rien ne change. Les assertions existantes `node '<BIN>' engine …` doivent passer telles quelles.

---

### Tâche 1 : Commande de lancement et version installée dans `src/update.ts`

**Test :** `pnpm exec vitest run test/install/update.test.ts`

**Fichiers :**
- Modifier : `src/update.ts`
- Tests : `test/install/update.test.ts` (ajouts ; ne pas toucher aux tests existants)

**Interfaces produites (utilisées par les tâches 2 et 3) :**
- `export const PACKAGE_ROOT: string`, racine du paquet en cours d'exécution : `join(dirname(fileURLToPath(import.meta.url)), '..')`.
- `export function installDir(env: NodeJS.ProcessEnv = process.env): string`, le calcul actuel d'`installedBin` sorti dans sa propre fonction. `installedBin(env)` devient `join(installDir(env), 'current', 'bin', 'herness')` et garde le même comportement.
- `export function runsInstalled(env: NodeJS.ProcessEnv = process.env, root: string = PACKAGE_ROOT): boolean` : vrai si `realpathSync(root)` est strictement sous `realpathSync(join(installDir(env), 'versions'))` (préfixe suivi de `sep`). Faux si l'un des `realpathSync` lève.
- `export interface HernessCommand { cmd: string; args: string[] }`
- `export function hernessCommand(env: NodeJS.ProcessEnv = process.env, root: string = PACKAGE_ROOT): HernessCommand` : si `runsInstalled(env, root)` et que `installedBin(env)` existe (`existsSync`), renvoie `{ cmd: installedBin(env), args: [] }`. Sinon `{ cmd: 'node', args: [join(root, 'bin', 'herness.js')] }`.
- `export function shellLine(c: HernessCommand, words: string): string` : ligne à taper dans un panneau herdr. `cmd` reste nu s'il vaut exactement `'node'`, sinon il est cité. Chaque élément de `args` est cité. `words` (sous-commande et identifiants, déjà sûrs) est ajouté tel quel après une espace. Citation : `'…'`, avec `'` remplacé par `'\''`, comme le `shq` de `src/lifecycle.ts`.
- `export function installedVersion(env: NodeJS.ProcessEnv = process.env): string | null` : `version` lue dans `join(installDir(env), 'current', 'package.json')`. `null` si le fichier manque, si le JSON est invalide ou si `version` n'est pas une chaîne non vide.
- `export function staleNotice(own: string, env: NodeJS.ProcessEnv = process.env, root: string = PACKAGE_ROOT): string | null` : `null` si `!runsInstalled(env, root)`, si `installedVersion(env)` vaut `null` ou s'il est égal à `own`. Sinon : `` `herness ${installed} installé, ce cockpit tourne en ${own} : quitte-le et relance herness` ``.

- [ ] **Étape 1 : écrire les tests qui échouent.** Dans `test/install/update.test.ts`, chaque test construit un dossier temporaire `data` (`mkdtemp`), passé par `env = { HERNESS_INSTALL_DIR: data, HOME: '/home/x' }`. Le lien `current` se crée avec `symlink('versions/0.8.0', join(data, 'current'))`. Tests à ajouter :
  - `installDir suit HERNESS_INSTALL_DIR, puis XDG_DATA_HOME, puis HOME` : `'/opt/h'`, `'/d/herness'`, `'/home/x/.local/share/herness'`.
  - `runsInstalled : vrai pour une racine sous versions/, aussi atteinte par le lien current` : avec `data/versions/0.8.0` créé, `runsInstalled(env, join(data, 'versions', '0.8.0'))` et `runsInstalled(env, join(data, 'current'))` valent `true`.
  - `runsInstalled : faux pour un dossier de sources ou sans dossier versions` : `runsInstalled(env, process.cwd())` vaut `false`. Avec un `data` vide (pas de `versions/`), il vaut aussi `false`, sans exception.
  - `hernessCommand : lanceur installé si la version tourne depuis versions/ et que current/bin/herness existe` : on crée `data/versions/0.8.0/bin/herness`, on pose le lien `current`, root = `join(data, 'versions', '0.6.0')` (dossier créé). Résultat attendu : `{ cmd: join(data, 'current', 'bin', 'herness'), args: [] }`.
  - `hernessCommand : node + bin/herness.js hors installation ou si le lanceur installé manque` : root = `process.cwd()` donne `{ cmd: 'node', args: [join(process.cwd(), 'bin', 'herness.js')] }`. Root sous `versions/` sans `current/bin/herness` donne `{ cmd: 'node', args: [join(root, 'bin', 'herness.js')] }`.
  - `shellLine cite les chemins et laisse node nu` : `shellLine({ cmd: 'node', args: ["/a b/it's/herness.js"] }, 'engine x')` vaut `` `node '/a b/it'\''s/herness.js' engine x` ``. `shellLine({ cmd: '/d/current/bin/herness', args: [] }, 'cockpit')` vaut `` `'/d/current/bin/herness' cockpit` ``.
  - `installedVersion lit current/package.json, null sinon` : `{"version":"0.8.0"}` donne `'0.8.0'`. Fichier absent, `'{'` et `{"name":"x"}` donnent chacun `null`.
  - `staleNotice : message seulement si la version installée diffère et que le processus tourne depuis une installation` : avec `current/package.json` en `0.8.0` et root sous `versions/`, `staleNotice('0.6.0', env, root)` vaut exactement `'herness 0.8.0 installé, ce cockpit tourne en 0.6.0 : quitte-le et relance herness'`. `staleNotice('0.8.0', env, root)` vaut `null`, `staleNotice('0.6.0', env, process.cwd())` vaut `null`, et sans `package.json` le résultat vaut `null`.
- [ ] **Étape 2 : lancer `pnpm exec vitest run test/install/update.test.ts`.** Attendu : ÉCHEC, les fonctions n'existent pas.
- [ ] **Étape 3 : implémenter les interfaces ci-dessus dans `src/update.ts`**, avec des API synchrones (`existsSync`, `realpathSync`, `readFileSync`). Une ligne de JSDoc en français par export, dans le style du fichier.
- [ ] **Étape 4 : relancer la commande de test.** Attendu : tout passe, y compris les tests existants d'`installedBin`. Lancer aussi `pnpm run typecheck` : aucune erreur.
- [ ] **Étape 5 : commiter**, par exemple `git commit -m "feat: commande de lancement de la version installée et lecture de sa version"`.

### Tâche 2 : Lancer herness par `hernessCommand()` aux quatre points de lancement

**Test :** `pnpm exec vitest run test/install/launch.test.ts test/mcp/server.test.ts test/ui/actions.test.ts test/ui/location.test.ts test/cli/lifecycle.test.ts`

**Fichiers :**
- Modifier : `src/lifecycle.ts` (constante `BIN` et `shq` lignes 32-34 ; appels `paneRun` lignes 152-155 et 207-212)
- Modifier : `src/ui/actions.ts` (constante `BIN` ligne 13 ; `restartDetached` ligne 97)
- Modifier : `src/mcp/server.ts` (`packageRoot` et `missionMcpConfig`, lignes 206-215)
- Modifier : `src/ui/location.ts` (constante `BIN` ligne 9 ; `createTab` ligne 44)
- Créer : `test/install/launch.test.ts`
- Modifier : `test/mcp/server.test.ts` (lignes 167-168), `test/ui/actions.test.ts` (lignes 104-106)

**Interfaces consommées (tâche 1) :** `hernessCommand(): HernessCommand`, `shellLine(c: HernessCommand, words: string): string`, depuis `src/update.ts`.

**Comportement attendu :** `hernessCommand()` est appelé au moment de chaque lancement, jamais figé dans une constante de module.
- `lifecycle.ts` : `paneRun(pane, shellLine(hernessCommand(), \`engine ${id}\`))`, et de même pour `tasks ${id}`, `voir spec ${id}` et `voir plan ${id}`, au démarrage comme à la reprise.
- `location.ts` : `shellLine(hernessCommand(), 'cockpit')`.
- `actions.ts` : `const c = hernessCommand()` puis `spawn(c.cmd, [...c.args, 'reprendre', id, '--redemarrer'], …)`.
- `server.ts` : `mcp.json` contient `{ command: c.cmd, args: [...c.args, 'mcp', id] }`.

Supprimer les constantes `BIN` et `packageRoot` devenues inutiles, ainsi que `shq` si plus rien ne l'utilise. En mode sources, les lignes `node '<BIN>' engine …` des tests de `lifecycle` et `location` restent identiques et ne doivent pas être modifiées.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - Créer `test/install/launch.test.ts`. En tête, `vi.mock('../../src/update.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/update.ts')>()), hernessCommand: () => ({ cmd: "/inst/current/bin/herness", args: [] }) }))`. Un `HERNESS_HOME` temporaire est créé en `beforeEach` et supprimé en `afterEach`, comme dans `test/ui/actions.test.ts`. Tests :
    - `missionMcpConfig écrit le lanceur installé` : le JSON de `missionMcpConfig('T-1')` a `mcpServers.herness` égal à `{ command: '/inst/current/bin/herness', args: ['mcp', 'T-1'] }`.
    - `restartDetached lance le lanceur installé` : avec un `Spawner` factice (comme dans `test/ui/actions.test.ts`), `cmd` vaut `'/inst/current/bin/herness'` et `args` vaut `['reprendre', 'm1', '--redemarrer']`.
    - `openCockpit lance le cockpit par le lanceur installé` : avec `FakeHerdr`, `seedWorkspace('demo')` et la config `demo` (comme dans `test/ui/location.test.ts`), `h.runs[0]?.cmd` vaut `` `'/inst/current/bin/herness' cockpit` ``.
  - `test/mcp/server.test.ts` : remplacer les deux assertions des lignes 167-168 par `expect(j.mcpServers.herness).toEqual({ command: 'node', args: [expect.stringMatching(/\/bin\/herness\.js$/), 'mcp', 'T-1'] })`.
  - `test/ui/actions.test.ts` : `expect(cmd).toBe('node')` à la place de `process.execPath`. Les assertions sur `args[0]` et `args.slice(1)` restent.
- [ ] **Étape 2 : lancer la commande de test.** Attendu : ÉCHEC dans `launch.test.ts` (chemins encore codés en dur), dans `server.test.ts` (forme de `mcp.json`) et dans `actions.test.ts` (`process.execPath`).
- [ ] **Étape 3 : remplacer les chemins codés en dur** aux quatre endroits, comme décrit dans « Comportement attendu ».
- [ ] **Étape 4 : relancer la commande de test.** Attendu : tout passe, et les assertions `node '${BIN}' …` de `test/cli/lifecycle.test.ts` et `test/ui/location.test.ts` passent sans modification. Lancer aussi `pnpm run typecheck` : aucune erreur.
- [ ] **Étape 5 : commiter**, par exemple `git commit -m "fix: lancer moteur, panneaux, MCP et cockpit avec la version installée active"`.

### Tâche 3 : Bandeau « version installée plus récente » dans le cockpit, et README

**Test :** `pnpm exec vitest run test/ui/cockpit.test.tsx`

**Fichiers :**
- Modifier : `src/ui/cockpit.tsx` (props de `Cockpit` lignes 124-144, boucle `poll` lignes 196-216, `CockpitLayout` lignes 70-98)
- Modifier : `test/ui/cockpit.test.tsx` (ajouts)
- Modifier : `README.md`, section « Mise à jour » (lignes 27-34)

**Interfaces consommées (tâche 1) :** `staleNotice(own: string): string | null` depuis `src/update.ts`, et `VERSION` depuis `src/version.ts`.

**Comportement attendu :**
- Nouvelle prop facultative de `Cockpit` : `notice?: () => string | null`, par défaut `() => staleNotice(VERSION)`.
- Elle est évaluée au premier `poll` puis à chaque `poll`. Son résultat est rangé dans un état `noticeText`. Si elle lève, le texte vaut `null` et la lecture des missions continue normalement.
- `CockpitLayout` reçoit `notice?: string | null` et, si la valeur n'est pas vide, affiche `<Text color="yellow">{notice}</Text>` juste sous `<Title …/>`, avant la liste.
- `CockpitSnapshot` (rendu hors TTY) ne change pas.

- [ ] **Étape 1 : écrire les tests qui échouent** dans `test/ui/cockpit.test.tsx`, au modèle des tests existants (`render(<Cockpit repoPath="/r" name="demo" load={…} actions={fakeActions().a} prCache={fakePrCache().cache} columns={140} …/>)`, `waitFor`, `waitGone`) :
  - `le cockpit affiche le bandeau de version sous le titre` : avec `notice={() => 'herness 0.8.0 installé, ce cockpit tourne en 0.6.0 : quitte-le et relance herness'}`, le texte apparaît dans `lastFrame()`, sur une ligne située après celle qui contient `herness · demo`.
  - `pas de bandeau quand notice renvoie null` : avec `notice={() => null}`, une fois les missions affichées, `lastFrame()` ne contient pas `installé, ce cockpit tourne en`.
  - `le bandeau suit les rafraîchissements` : `intervalMs={20}` et une `notice` qui renvoie `null` puis, après qu'une variable du test a été changée, le message. Le message finit par apparaître (`waitFor`).
  - `une notice qui lève n'empêche pas l'affichage des missions` : avec `notice={() => { throw new Error('x') }}`, la mission chargée s'affiche et aucun bandeau n'apparaît.
- [ ] **Étape 2 : lancer `pnpm exec vitest run test/ui/cockpit.test.tsx`.** Attendu : ÉCHEC sur les nouveaux tests (prop inconnue, texte absent).
- [ ] **Étape 3 : implémenter** la prop, son évaluation dans `poll` et l'affichage dans `CockpitLayout`, comme décrit ci-dessus.
- [ ] **Étape 4 : README.** Dans « Mise à jour », après le paragraphe existant, ajouter :
  > Tout ce que herness lance (moteur, tableau, visionneuses, serveur MCP, cockpit) démarre avec la version active au moment du lancement, même depuis un cockpit plus ancien. Le cockpit exécute lui-même la création des missions et les validations : s'il tourne sur une version antérieure à celle installée, il l'indique en jaune sous son titre. Quitte-le (`q`) et relance `herness`.
- [ ] **Étape 5 : relancer la commande de test.** Attendu : tout passe, y compris les tests existants du cockpit. Lancer aussi `pnpm run typecheck` : aucune erreur.
- [ ] **Étape 6 : commiter**, par exemple `git commit -m "feat(cockpit): signaler une version installée plus récente que le cockpit"`.
