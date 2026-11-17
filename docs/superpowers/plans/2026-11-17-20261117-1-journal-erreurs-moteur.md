# Journal des erreurs de herness : plan d'implémentation

> **Pour les agents :** chaque tâche se fait en TDD (test d'abord, rouge, code minimal, vert), puis un commit.

**But :** écrire automatiquement les erreurs imprévues de herness (moteur, serveur MCP, lancement de ces deux processus,
erreurs non rattrapées) dans `<HERNESS_HOME>/erreurs.log`, et donner à l'orchestrateur un outil `signaler_anomalie`
qui écrit dans le même fichier.

**Architecture :** un module `src/errlog.ts` (chemin du journal, ajout d'une entrée qui ne lève jamais, écouteurs de
processus, enveloppe de lancement) est appelé aux points où herness rattrape déjà ses erreurs : `Engine.fail` et
`Engine.run` (`src/engine/engine.ts`), `guard` (`src/mcp/server.ts`), actions `engine` et `mcp` (`src/cli.ts`).

**Technologies :** TypeScript (ESM, exécuté par tsx), vitest, `node:fs/promises`, SDK MCP, zod.

**Spec :** `docs/superpowers/specs/2026-11-17-20261117-1-journal-erreurs-moteur.md`

## Contraintes globales

- Fichier du journal : `join(hernessHome(), 'erreurs.log')`, où `hernessHome()` vaut `process.env.HERNESS_HOME ?? join(homedir(), '.local', 'state', 'herness')` (même racine que `missionsRoot()`).
- En-tête d'une entrée : `=== <ISO> · mission <id> · herness <VERSION> · <origine>[ (étape <step>)]` ; le segment ` · mission <id>` est omis si la mission est inconnue, le segment ` (étape <step>)` si l'étape est inconnue.
- Corps : `err.stack` pour une `Error` qui en a une (sinon `${err.name}: ${err.message}`), `String(err)` pour toute autre valeur, le texte tel quel pour une chaîne ; une `Error` avec `cause` ajoute une ligne `cause :` puis le corps de la cause.
- Une entrée est suivie d'une ligne vide ; elle est écrite en un seul appel `appendFile` (le moteur et le serveur MCP peuvent écrire en même temps).
- Le journal n'écrit jamais sur stdout (protocole MCP) ; une écriture impossible est ignorée (au plus un `console.error`), jamais levée.
- Les messages `console.error` existants sont conservés.
- Les tests fixent `HERNESS_HOME` sur un dossier temporaire ; aucun test n'écrit dans le vrai `~/.local/state`.
- Messages, commentaires et libellés en français, comme le reste du code.

## Points d'attention pour la revue

- `HERNESS_HOME` inutilisable (c'est un fichier, pas un dossier) : `logHernessError` se résout sans lever et le moteur bloque quand même la mission (tâche 1).
- Valeur levée qui n'est pas une `Error` (chaîne, objet) : l'entrée est écrite avec `String(err)` (tâche 1).
- `state.json` illisible pendant `Engine.fail` : l'erreur d'origine est journalisée sans étape, puis l'échec d'enregistrement du blocage aussi (tâche 2).
- Une erreur dans un outil MCP ne doit rien écrire sur stdout et l'outil répond toujours `Erreur : …` (tâche 3).
- Erreur non rattrapée dans `herness engine`/`herness mcp` : journalisée PUIS processus terminé avec le code 1, jamais avalée (tâche 4).

---

### Tâche 1 : Module `src/errlog.ts` (chemin et ajout d'une entrée)

**Test :** `pnpm vitest run test/errlog.test.ts`

**Fichiers :**
- Modifier : `src/paths.ts` (ajouter `hernessHome()`, l'utiliser dans `missionsRoot()`)
- Créer : `src/errlog.ts`
- Créer : `test/errlog.test.ts`

**Interfaces produites (utilisées par les tâches 2 à 4) :**
- `hernessHome(): string` dans `src/paths.ts`.
- `errorLogPath(): string` dans `src/errlog.ts` : `join(hernessHome(), 'erreurs.log')`.
- `export type ErrorContext = { mission?: string; origin: string; step?: string }`
- `logHernessError(ctx: ErrorContext, err: unknown): Promise<void>` : `mkdir(hernessHome(), { recursive: true })`, puis un seul `appendFile(errorLogPath(), entrée)`. Ne lève jamais (try/catch global ; en cas d'échec, `console.error('herness : journal des erreurs inaccessible : <message>')`). Horodatage : `new Date().toISOString()`. Version : `VERSION` de `src/version.ts`.

- [ ] **Étape 1 : écrire les tests qui échouent** dans `test/errlog.test.ts`. `beforeEach` : `HERNESS_HOME` sur un `mkdtemp` ; `afterEach` : suppression et `delete process.env.HERNESS_HOME`.
  - `errorLogPath vaut <HERNESS_HOME>/erreurs.log`.
  - `une Error donne un en-tête complet et sa pile` : `logHernessError({ mission: 'T-1', origin: 'moteur', step: 'tasks' }, new Error('boum'))` ; le fichier contient une ligne qui correspond à `/^=== \d{4}-\d\d-\d\dT[\d:.]+Z · mission T-1 · herness <VERSION> · moteur \(étape tasks\)$/m`, puis `Error: boum`, puis une ligne commençant par `    at `.
  - `sans mission ni étape, les segments sont omis` : en-tête qui finit par `· herness <VERSION> · lancement du moteur` et ne contient ni `mission` ni `étape`.
  - `une valeur qui n'est pas une Error est écrite telle quelle` : `logHernessError({ origin: 'x' }, 'texte libre')` → le corps est `texte libre` ; `logHernessError({ origin: 'x' }, 42)` → `42`.
  - `la cause d'une Error est ajoutée` : `new Error('haut', { cause: new Error('bas') })` → le fichier contient `cause :` puis `Error: bas`.
  - `deux entrées s'ajoutent, séparées par une ligne vide` : deux appels → deux lignes `=== `, et le contenu contient `\n\n=== `.
  - `n'écrit jamais sur stdout` : `vi.spyOn(console, 'log')` et `vi.spyOn(process.stdout, 'write')` ne sont pas appelés.
  - `ne lève jamais quand le journal est inaccessible` : `HERNESS_HOME` pointe sur un FICHIER existant ; `await expect(logHernessError({ origin: 'x' }, new Error('e'))).resolves.toBeUndefined()`.
- [ ] **Étape 2 : lancer `pnpm vitest run test/errlog.test.ts`** : échec (module introuvable).
- [ ] **Étape 3 : implémenter** `hernessHome()` (et `missionsRoot()` = `join(hernessHome(), 'missions')`, comportement inchangé) puis `src/errlog.ts` selon les interfaces ci-dessus et les contraintes globales.
- [ ] **Étape 4 : relancer `pnpm vitest run test/errlog.test.ts test/mission/ids.test.ts`** : tout passe.
- [ ] **Étape 5 : commit** `feat: journal des erreurs de herness (module errlog)`.

### Tâche 2 : Le moteur journalise ses erreurs imprévues

**Test :** `pnpm vitest run test/engine/engine.test.ts`

**Fichiers :**
- Modifier : `src/engine/engine.ts` (méthodes `Engine.fail` et `Engine.run`)
- Modifier : `test/engine/engine.test.ts`

**Interfaces consommées :** `logHernessError(ctx, err)`, `errorLogPath()` de `src/errlog.ts` (tâche 1).

**Comportement attendu :**
- `Engine.fail(err)` : lit l'étape de la mission (`loadState`) si possible, puis `logHernessError({ mission: this.id, origin: 'moteur', step }, err)` AVANT de bloquer ; si l'état est illisible, l'entrée est écrite sans étape. Le motif de blocage garde sa première ligne (`erreur du moteur : <message>`), garde la ligne des bases non supprimées si elle existe, et se termine par une ligne `détail : <errorLogPath()>`.
- Dans le `catch (err2)` de `fail` : en plus du `console.error` existant, `logHernessError({ mission: this.id, origin: 'moteur : enregistrement du blocage' }, err2)`.
- Les deux `catch` de démarrage de `Engine.run` : en plus du `console.error` existant, `logHernessError` avec l'origine `moteur : démarrage (nettoyage des panneaux)` puis `moteur : démarrage (arrêt des agents terminés)`, et `mission: this.id`.

- [ ] **Étape 1 : écrire les tests qui échouent** dans `test/engine/engine.test.ts` (le `beforeEach` existant fixe déjà `HERNESS_HOME = home`).
  - Compléter le test existant `run : une exception bloque la mission sans arrêter le moteur, qui continue jusqu'à stop` : `readFile(join(home, 'erreurs.log'), 'utf8')` contient `· mission T-1 · herness ` , `· moteur (étape classify)`, `branche verrouillée` et une ligne commençant par `    at ` ; `s.blockedReason` se termine par `\ndétail : ${join(home, 'erreurs.log')}` et sa première ligne commence par `erreur du moteur : `.
  - Nouveau test `état illisible : les erreurs de démarrage et du blocage sont journalisées sans étape` : ne pas appeler `mission()` (aucun `state.json`), `engine({ sleep: async () => { throw new Error('fin du test') } })`, `await expect(eng.run()).rejects.toThrow('fin du test')` ; le journal contient les origines `moteur : démarrage (nettoyage des panneaux)`, `moteur : démarrage (arrêt des agents terminés)`, `· moteur` (en fin d'en-tête, sans `(étape`) et `moteur : enregistrement du blocage`.
- [ ] **Étape 2 : lancer `pnpm vitest run test/engine/engine.test.ts`** : les deux tests échouent (journal absent).
- [ ] **Étape 3 : implémenter** le comportement attendu dans `src/engine/engine.ts`.
- [ ] **Étape 4 : relancer `pnpm vitest run test/engine/engine.test.ts`** : tout passe, y compris les tests existants qui vérifient `blockedReason` (adapter seulement ceux qui comparent le motif complet à l'égalité, en ajoutant la ligne `détail : …`).
- [ ] **Étape 5 : commit** `feat: le moteur journalise ses erreurs imprévues`.

### Tâche 3 : Serveur MCP : erreurs des outils journalisées et outil `signaler_anomalie`

**Test :** `pnpm vitest run test/mcp/server.test.ts test/prompts/render.test.ts`

**Fichiers :**
- Modifier : `src/mcp/server.ts`
- Modifier : `src/prompts/orchestrator.md` (section « Tes outils (serveur MCP herness) »)
- Modifier : `test/mcp/server.test.ts`
- Modifier : `test/prompts/render.test.ts`

**Interfaces consommées :** `logHernessError(ctx, err)`, `errorLogPath()` (tâche 1).

**Comportement attendu :**
- `guard` prend la mission et le nom de l'outil : `guard(id: string, tool: string, fn)`. Sur exception, il appelle `logHernessError({ mission: id, origin: \`outil MCP ${tool}\` }, e)` puis rend `fail(\`Erreur : ${message}\`)` comme aujourd'hui. Tous les `registerTool` passent leur nom.
- Nouvel outil `signaler_anomalie`, `inputSchema: { description: z.string() }`, description : `Signale une anomalie de herness constatée sans erreur (moteur incohérent, message contradictoire avec statut, outil qui ne fait pas ce qu'il annonce). Jamais pour un échec normal de mission.` Comportement :
  - description vide ou faite d'espaces : `fail('Description vide : décris ce que tu as observé, ce que tu attendais et les identifiants utiles (porte, tâche).')`, rien n'est écrit ;
  - sinon : étape lue par `loadState(id)` si possible (sinon omise), `logHernessError({ mission: id, origin: "signalement de l'orchestrateur", step }, description.trim())`, puis `ok(\`Anomalie signalée dans ${errorLogPath()}.\`)`. Rien n'est posté dans la boîte du moteur, l'état n'est pas modifié.
- `src/prompts/orchestrator.md`, section « Tes outils », ajouter après `abandonner` une puce `signaler_anomalie(description)` qui dit : à utiliser quand tu constates un défaut de herness lui-même sans erreur (moteur incohérent, message `[herness]` qui contredit `statut`, outil qui ne fait pas ce qu'il annonce) ; décris ce que tu as observé, ce que tu attendais et les identifiants utiles (porte, tâche) ; jamais pour un échec normal de mission (tests rouges, agent bloqué, revue négative) ; les erreurs imprévues de herness sont déjà journalisées automatiquement ; préviens l'utilisateur que tu as fait un signalement.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `test/mcp/server.test.ts` : dans le test de la liste des outils, ajouter `'signaler_anomalie'` à la liste triée attendue.
  - `une exception d'outil est journalisée avec le nom de l'outil` : `rm(join(missionDir('T-1'), 'state.json'))` puis `call('statut')` → `isError` vrai, texte qui commence par `Erreur : ` ; `erreurs.log` (dans `home`) contient `· mission T-1 · herness ` et `· outil MCP statut`.
  - `signaler_anomalie écrit la description avec l'étape et ne poste rien` : `state` a l'étape par défaut de `newState` (lire `state.step`) ; `call('signaler_anomalie', { description: '  le moteur annonce g3 mais statut ne la montre pas  ' })` → pas d'erreur, texte qui contient `join(home, 'erreurs.log')` ; le journal contient `· signalement de l'orchestrateur (étape ${state.step})` et `le moteur annonce g3 mais statut ne la montre pas` (sans les espaces de bord) ; `drainInbox('T-1')` vaut `[]`.
  - `signaler_anomalie refuse une description vide` : `{ description: '   ' }` → `isError` vrai, texte qui contient `Description vide`, aucun fichier `erreurs.log`.
  - `test/prompts/render.test.ts`, test `orchestrator.md mentionne le format…` : ajouter `'signaler_anomalie'` à la liste des outils attendus.
- [ ] **Étape 2 : lancer `pnpm vitest run test/mcp/server.test.ts test/prompts/render.test.ts`** : les nouveaux tests échouent.
- [ ] **Étape 3 : implémenter** `guard`, l'outil et la puce du prompt.
- [ ] **Étape 4 : relancer `pnpm vitest run test/mcp/server.test.ts test/prompts/render.test.ts`** : tout passe.
- [ ] **Étape 5 : commit** `feat: le serveur MCP journalise ses erreurs et l'orchestrateur peut signaler une anomalie`.

### Tâche 4 : Lancement et erreurs non rattrapées des processus `engine` et `mcp`

**Test :** `pnpm vitest run test/errlog.test.ts`

**Fichiers :**
- Modifier : `src/errlog.ts`
- Modifier : `src/cli.ts` (actions `mcp <id>` et `engine <id>`)
- Modifier : `test/errlog.test.ts`

**Interfaces consommées :** `logHernessError`, `ErrorContext` (tâche 1).

**Interfaces produites (dans `src/errlog.ts`) :**
- `withErrorLog<T>(ctx: ErrorContext, fn: () => Promise<T>): Promise<T>` : rend le résultat de `fn` ; si `fn` lève, `await logHernessError(ctx, err)` puis relève la MÊME erreur.
- `export type ErrorProcess = { on(event: 'uncaughtException' | 'unhandledRejection', listener: (err: unknown) => Promise<void>): unknown; exit(code: number): void }`
- `installProcessErrorLog(ctx: ErrorContext, proc: ErrorProcess = process): void` : installe un écouteur `async` pour `uncaughtException` et pour `unhandledRejection` ; chacun fait `await logHernessError(ctx, err)`, puis `console.error` de la pile (ou `String(err)`) préfixée par `herness : `, puis `proc.exit(1)`. (Pour `process`, adapter le type si besoin, par exemple `process as unknown as ErrorProcess`.)

**Câblage dans `src/cli.ts` :**
- Action `engine <id>` : `installProcessErrorLog({ mission: id, origin: 'moteur : erreur non rattrapée' })` en premier, puis tout le corps actuel enveloppé par `withErrorLog({ mission: id, origin: 'lancement du moteur' }, …)`. Ne pas envelopper `Engine.run` lui-même dans cette enveloppe : seules les erreurs levées avant `run()` (lecture de l'état, de la config) relèvent du lancement ; une erreur qui sortirait de `run()` reste levée comme aujourd'hui et sera prise par l'écouteur.
- Action `mcp <id>` : `installProcessErrorLog({ mission: id, origin: 'serveur MCP : erreur non rattrapée' })`, puis le corps actuel enveloppé par `withErrorLog({ mission: id, origin: 'lancement du serveur MCP' }, …)`.
- `missionDir(id)` valide l'identifiant : ne pas l'appeler pour construire le contexte (le contexte prend `id` tel quel).

- [ ] **Étape 1 : écrire les tests qui échouent** dans `test/errlog.test.ts`.
  - `withErrorLog rend le résultat sans rien écrire` : `await withErrorLog({ origin: 'x' }, async () => 7)` vaut `7` ; pas de fichier `erreurs.log`.
  - `withErrorLog journalise puis relève la même erreur` : `const boom = new Error('état illisible')` ; `await expect(withErrorLog({ mission: 'T-1', origin: 'lancement du moteur' }, async () => { throw boom })).rejects.toBe(boom)` ; le journal contient `· mission T-1 · herness ` , `· lancement du moteur` et `état illisible`.
  - `installProcessErrorLog journalise puis sort avec le code 1` : un faux processus qui garde les écouteurs dans un `Map` et un `exit = vi.fn()` ; `vi.spyOn(console, 'error').mockImplementation(() => {})` ; après installation, les deux événements `uncaughtException` et `unhandledRejection` ont un écouteur ; `await listeners.get('unhandledRejection')!(new Error('promesse perdue'))` → le journal contient `· serveur MCP : erreur non rattrapée` et `promesse perdue`, `exit` a été appelé avec `1`, APRÈS l'écriture (vérifier que le fichier existe quand `exit` est appelé, par exemple avec `exit = vi.fn(() => { écrit = existsSync(errorLogPath()) })`).
- [ ] **Étape 2 : lancer `pnpm vitest run test/errlog.test.ts`** : les nouveaux tests échouent.
- [ ] **Étape 3 : implémenter** `withErrorLog`, `installProcessErrorLog` et le câblage de `src/cli.ts`.
- [ ] **Étape 4 : lancer `pnpm vitest run test/errlog.test.ts && pnpm run typecheck`** : tout passe.
- [ ] **Étape 5 : commit** `feat: lancement et erreurs non rattrapées du moteur et du serveur MCP journalisés`.
